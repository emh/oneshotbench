import { bad } from '../server/validation.mjs';
import { json } from './api.mjs';
export const columns = {
  prompts: ['id', 'archived', 'created_at'],
  versions: ['id', 'prompt_id', 'version', 'title', 'category', 'content', 'locked_at', 'updated_at'],
  runs: ['id', 'batch_id', 'version_id', 'model_id', 'model_name', 'created_at', 'started_at', 'finished_at', 'status', 'config', 'error', 'metrics', 'provider', 'response_id', 'finish_reason', 'resolved_model'],
};
function insert(db, table, row) {
  const keys = columns[table];
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => row[key] ?? null));
}
export async function importSnapshot(request, workspace) {
  if (workspace.env.ALLOW_IMPORT !== 'true') throw bad('Migration endpoint is disabled.', 403);
  const source = await request.text();
  if (source.length > 16_000_000) throw bad('Import item too large.', 413);
  const body = JSON.parse(source), db = workspace.store.db;
  if (typeof body.snapshotId !== 'string' || !/^[\w-]{1,100}$/.test(body.snapshotId)) throw bad('Invalid snapshot ID');
  const saved = db.prepare("SELECT value FROM private WHERE name='migration'").get();
  const migration = saved ? JSON.parse(saved.value) : null;
  if (migration && migration.id !== body.snapshotId) throw bad('Another migration already exists.', 409);
  if (body.phase === 'start') {
    if (migration) return json(migration);
    if (db.prepare('SELECT id FROM prompts LIMIT 1').get()) throw bad('Import requires an empty workspace.', 409);
    if (!Array.isArray(body.prompts) || !Array.isArray(body.versions) || !Number.isInteger(body.runCount) || body.runCount < 0) throw bad('Invalid snapshot');
    const record = { id: body.snapshotId, count: body.runCount, complete: false };
    workspace.store.transaction(() => {
      for (const prompt of body.prompts) insert(db, 'prompts', prompt);
      for (const version of body.versions) insert(db, 'versions', version);
      // Only existing settings keys can be imported; credentials are never settings.
      const settings = Object.fromEntries(Object.keys(workspace.store.settings()).filter(k => k in body.settings).map(k => [k, body.settings[k]]));
      settings.timeoutSeconds = Math.min(settings.timeoutSeconds || 300, 1740);
      workspace.store.saveSettings(settings);
      db.prepare("INSERT INTO private VALUES ('migration',?)").run(JSON.stringify(record));
    });
    return json(record);
  }
  if (!migration) throw bad('Start the migration first.', 409);
  if (body.phase === 'run') {
    const run = body.run;
    if (!run || !/^[\w-]{1,100}$/.test(run.id)) throw bad('Invalid run');
    if (db.prepare('SELECT id FROM runs WHERE id=?').get(run.id)) return json({ ok: true, existing: true });
    if (migration.complete) throw bad('Migration already complete.', 409);
    if (['running', 'queued'].includes(run.status)) {
      run.status = 'interrupted'; run.finished_at = new Date().toISOString();
      run.error = 'Imported active job; not replayed to avoid duplicate charges.';
    }
    const { html, raw } = run;
    await workspace.env.OUTPUTS.put(`runs/${run.id}.json`, JSON.stringify({ html, raw }),
      { httpMetadata: { contentType: 'application/json' } });
    // Two resumed imports can overlap while writing R2; insert only once.
    if (!db.prepare('SELECT id FROM runs WHERE id=?').get(run.id)) insert(db, 'runs', run);
    return json({ ok: true });
  }
  if (body.phase === 'finish') {
    const count = db.prepare('SELECT COUNT(*) AS count FROM runs').get().count;
    if (count !== migration.count) throw bad(`Expected ${migration.count} runs, received ${count}.`, 409);
    migration.complete = true;
    db.prepare("UPDATE private SET value=? WHERE name='migration'").run(JSON.stringify(migration));
    return json(migration);
  }
  throw bad('Unknown migration phase');
}
