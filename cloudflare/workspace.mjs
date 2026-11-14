import { StoreCore } from '../server/store-core.mjs';
import { database } from './sqlite.mjs';
import { api, json } from './api.mjs';
import { seal, unseal } from './auth.mjs';
import { bad } from '../server/validation.mjs';
import { importSnapshot } from './import.mjs';
import { modelCatalog } from '../server/reasoning.mjs';

export class WorkspaceService {
  constructor(ctx, env, { fetchImpl = fetch } = {}) {
    this.ctx = ctx; this.env = env;
    this.models = modelCatalog(fetchImpl);
    this.store = new StoreCore(database(ctx.storage), { seed: false });
    this.store.db.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, claimed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS private (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  async key() {
    const saved = this.store.db.prepare("SELECT value FROM private WHERE name='openrouter'").get();
    return saved ? unseal(saved.value, this.env.KEY_ENCRYPTION_SECRET) : this.env.OPENROUTER_API_KEY;
  }
  async saveKey(key) {
    const value = await seal(key, this.env.KEY_ENCRYPTION_SECRET);
    this.store.db.prepare("INSERT OR REPLACE INTO private VALUES ('openrouter',?)").run(value);
  }
  async wake() { await this.ctx.storage.setAlarm(Date.now() + 1000); }
  async result(run) {
    const artifact = await this.env.OUTPUTS.get(`runs/${run.id}.json`);
    if (!artifact) return run;
    const { html, raw } = await artifact.json();
    return { ...run, html, raw };
  }
  async cancel(run) {
    if (!['queued', 'running'].includes(run.status)) throw bad('This run has already finished.', 409);
    this.store.updateRun(run.id, { status: 'cancelled', finished_at: new Date().toISOString(),
      error: run.status === 'running' ? 'Request cancelled. The provider may still charge for work already performed.' : null });
    if (run.status === 'running') {
      try { await (await this.env.RUNS.get(run.id)).terminate(); } catch { /* Alarm cleans up terminal instances. */ }
    }
    await this.wake();
  }
  async finish(id) {
    const artifact = await this.env.OUTPUTS.get(`runs/${id}.json`);
    const run = this.store.run(id);
    if (artifact && run) {
      const { html, raw, ...patch } = await artifact.json();
      // Keep cancellation terminal, but retain usage already incurred.
      if (run.status === 'cancelled') {
        delete patch.status; delete patch.error; delete patch.finished_at;
      }
      this.store.updateRun(id, patch);
    }
    await this.wake();
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/import' && request.method === 'POST') return await importSnapshot(request, this);
      const migration = this.store.db.prepare("SELECT value FROM private WHERE name='migration'").get();
      if (migration && !JSON.parse(migration.value).complete && !['GET', 'HEAD'].includes(request.method))
        throw bad('Finish the workspace import before making changes.', 409);
      if (path.startsWith('/internal/')) {
        const { id } = await request.json();
        if (path === '/internal/claim') {
          // Await the key first. The claim and status check below have no async gap.
          const key = await this.key();
          const run = this.store.run(id);
          if (!run || run.status !== 'running' || this.store.db.prepare('SELECT id FROM attempts WHERE id=?').get(id)) return json({});
          this.store.db.prepare('INSERT INTO attempts VALUES (?,?)').run(id, new Date().toISOString());
          return json({ run, key });
        }
        if (path === '/internal/finish') { await this.finish(id); return json({ ok: true }); }
        throw bad('Not found', 404);
      }
      return await api(request, this);
    } catch (error) {
      let message = error.message || 'Unexpected server error';
      try { const key = await this.key(); if (key) message = message.split(key).join('[redacted]'); } catch {}
      return json({ error: message }, error.status || 500);
    }
  }
  async alarm() {
    // Persist the next wake before doing network work; restarts cannot strand the queue.
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    const running = this.store.runs().filter(r => r.status === 'running');
    for (const run of running) {
      if (await this.env.OUTPUTS.head(`runs/${run.id}.json`)) { await this.finish(run.id); continue; }
      let status;
      try { status = (await (await this.env.RUNS.get(run.id)).status()).status; } catch {}
      if (this.store.run(run.id)?.status !== 'running') continue;
      if (['errored', 'terminated', 'complete'].includes(status) || Date.now() - Date.parse(run.started_at) > (run.config.timeoutSeconds + 300) * 1000) {
        this.store.updateRun(run.id, { status: 'interrupted', finished_at: new Date().toISOString(),
          error: 'Execution stopped without a saved response. Not retried to avoid duplicate charges.' });
      } else if (!status) {
        // Deterministic instance IDs make a dispatch retry safe after a lost response.
        try { await this.env.RUNS.create({ id: run.id, params: { id: run.id } }); } catch {}
      }
    }
    const active = this.store.runs().filter(r => r.status === 'running').length;
    const waiting = this.store.runs().filter(r => r.status === 'queued').reverse().slice(0, Math.max(0, this.store.settings().concurrency - active));
    for (const run of waiting) {
      if (this.store.run(run.id)?.status !== 'queued') continue;
      this.store.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });
      try { await this.env.RUNS.create({ id: run.id, params: { id: run.id } }); } catch {}
    }
    if (!this.store.runs().some(r => ['queued', 'running'].includes(r.status))) await this.ctx.storage.deleteAlarm();
  }
}
