import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { WorkspaceService } from '../cloudflare/workspace.mjs';
import { executeRun, generate } from '../cloudflare/generate.mjs';
import { route } from '../cloudflare/router.mjs';
import { authenticate, seal, unseal } from '../cloudflare/auth.mjs';
import { deployment } from '../scripts/cloudflare-deploy.mjs';
import publicWorker from '../cloudflare/public.mjs';
const html = '<!doctype html><html><body>Fixture</body></html>';
test('public Worker exposes only the enabled read-only gallery', async () => {
  let forwarded = 0;
  const env = { PUBLIC_GALLERY: 'true', GALLERY_ORIGIN: 'https://example.github.io',
    WORKSPACE: { getByName: () => ({ fetch: async () => { forwarded++; return Response.json({ runs: [] }); } }) } };
  for (const path of ['/api/state', '/api/settings', '/api/import', '/internal/claim', '/'])
    assert.equal((await publicWorker.fetch(new Request('https://public.example.com' + path), env)).status, 404);
  assert.equal((await publicWorker.fetch(new Request('https://public.example.com/api/gallery', { method: 'POST' }), env)).status, 404);
  const req = new Request('https://public.example.com/api/gallery', { headers: { Origin: env.GALLERY_ORIGIN } });
  const response = await publicWorker.fetch(req, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.GALLERY_ORIGIN);
  assert.equal(forwarded, 1);
  assert.equal((await publicWorker.fetch(req, { ...env, PUBLIC_GALLERY: 'false' })).status, 404);
});
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: { exec(sql, ...args) {
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const rows = db.prepare(sql).all(...args);
      return { toArray: () => rows, rowsWritten: db.prepare('SELECT total_changes() AS n').get().n - before };
    } },
    transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async setAlarm(n) { this.alarm = n; }, async deleteAlarm() { this.alarm = null; },
  };
  const objects = new Map(), jobs = new Map();
  const env = {
    ADMIN_ORIGIN: 'https://admin.example.com', GALLERY_ORIGIN: 'https://example.github.io', PUBLIC_GALLERY: 'false',
    OPENROUTER_API_KEY: 'sk-or-test', KEY_ENCRYPTION_SECRET: 'fixture-encryption-secret-32-characters',
    OUTPUTS: {
      async get(key) { const value = objects.get(key); return value ? { json: async () => JSON.parse(value) } : null; },
      async put(key, value) { objects.set(key, value); }, async head(key) { return objects.has(key); },
      async delete(key) { objects.delete(key); },
    },
    RUNS: {
      async create({ id }) { if (jobs.has(id)) throw Error('exists'); jobs.set(id, 'queued'); },
      async get(id) { if (!jobs.has(id)) throw Error('missing'); return {
        status: async () => ({ status: jobs.get(id) }), terminate: async () => jobs.set(id, 'terminated'),
      }; },
    },
  };
  const workspace = new WorkspaceService({ storage }, env);
  env.WORKSPACE = { getByName: () => ({ fetch: req => workspace.fetch(req) }) };
  const store = workspace.store;
  store.saveSettings({ selectedModels: [{ id: 'test/model', name: 'Test model' }], concurrency: 2 });
  return { workspace, store, env, jobs, objects, storage };
}
const request = (path, body, method = 'POST') => new Request('https://admin.example.com' + path, {
  method, headers: { 'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('bulk run deletion terminates active jobs, removes artifacts, and preserves locked prompt versions', async t => {
  const { store, workspace, env, jobs, objects } = fixture(t);
  const prompt = store.createPrompt({ title: 'Delete fixture', category: 'Test', content: 'Keep this prompt' });
  const ids = Array.from({ length: 3 }, () => store.enqueue([prompt.id], ['test/model']).ids[0]);
  await workspace.alarm();
  store.updateRun(ids[1], { status: 'completed' });
  objects.set(`runs/${ids[1]}.json`, JSON.stringify({ html, raw: html }));
  const invalid = await workspace.fetch(request('/api/runs', { ids: [] }, 'DELETE'));
  assert.equal(invalid.status, 400);
  assert.equal(store.runs().length, 3);
  const result = await workspace.fetch(request('/api/runs', { ids: [...ids, ids[0]] }, 'DELETE'));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).deleted.length, 3);
  assert.equal(store.runs().length, 0);
  assert.equal(objects.size, 0);
  assert.equal(jobs.get(ids[0]), 'terminated');
  assert.ok(store.prompt(prompt.id).locked_at);
  assert.equal(store.prompt(prompt.id).run_count, 0);
  assert.equal(store.prompt(prompt.id).content, 'Keep this prompt');
  const claim = await workspace.fetch(request('/internal/claim', { id: ids[0] }));
  assert.deepEqual(await claim.json(), {});
  // A request that finished while deletion was in progress cannot restore its artifact.
  objects.set(`runs/${ids[0]}.json`, JSON.stringify({ status: 'completed', html, raw: html }));
  await workspace.finish(ids[0]);
  assert.equal(objects.size, 0);
  assert.equal(store.run(ids[0]), undefined);
  assert.deepEqual((await (await workspace.fetch(request('/api/runs', { ids }, 'DELETE'))).json()).deleted, []);
  const gallery = await workspace.fetch(new Request('https://admin.example.com/api/gallery'));
  assert.equal((await gallery.json()).runs.length, 0);
});

test('failed artifact cleanup remains durable and is retried by the alarm', async t => {
  const { store, workspace, env, objects, storage } = fixture(t);
  const prompt = store.createPrompt({ title: 'Cleanup', category: 'Test', content: 'HTML' });
  const id = store.enqueue([prompt.id], ['test/model']).ids[0];
  store.updateRun(id, { status: 'completed' });
  objects.set(`runs/${id}.json`, JSON.stringify({ html }));
  const remove = env.OUTPUTS.delete;
  env.OUTPUTS.delete = async () => { throw Error('Temporary storage error'); };
  const result = await workspace.deleteRuns([id]);
  assert.equal(result.cleanupPending, 1);
  assert.equal(store.run(id), undefined);
  assert.ok(storage.alarm);
  env.OUTPUTS.delete = remove;
  const recovered = new WorkspaceService({ storage }, env);
  await recovered.alarm();
  assert.equal(objects.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM run_deletions').get().n, 0);
  assert.equal(storage.alarm, null);
});

test('workflow termination failures keep cleanup pending until the next alarm', async t => {
  const { store, workspace, env, jobs, storage } = fixture(t);
  const prompt = store.createPrompt({ title: 'Active cleanup', category: 'Test', content: 'HTML' });
  const id = store.enqueue([prompt.id], ['test/model']).ids[0];
  await workspace.alarm();
  const get = env.RUNS.get;
  env.RUNS.get = async () => { throw Error('Temporary workflow outage'); };
  assert.equal((await workspace.deleteRuns([id])).cleanupPending, 1);
  assert.equal(store.run(id), undefined);
  await workspace.alarm();
  assert.ok(storage.alarm);
  env.RUNS.get = get;
  await workspace.alarm();
  assert.equal(jobs.get(id), 'terminated');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM run_deletions').get().n, 0);
});

test('Cloudflare SQLite adapter preserves versions and queue concurrency without replaying paid calls', async t => {
  const { store, workspace, env, jobs } = fixture(t);
  const prompt = store.createPrompt({ title: 'Test', category: 'Test', content: 'Make a page' });
  const ids = Array.from({ length: 3 }, () => store.enqueue([prompt.id], ['test/model']).ids[0]);
  assert.ok(store.prompt(prompt.id).locked_at);
  store.editPrompt(prompt.id, { title: 'Test', category: 'Test', content: 'New text', baseVersionId: prompt.version_id });
  assert.equal(store.prompt(prompt.id).version, 2);
  assert.equal(store.run(ids[0]).prompt_content, 'Make a page');
  await workspace.alarm();
  assert.equal(jobs.size, 2);
  assert.equal(store.runs().filter(r => r.status === 'running').length, 2);
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ choices: [{ message: { content: html }, finish_reason: 'stop' }], usage: { cost: 0.02 } }); };
  await executeRun(env, ids[0], fetchImpl);
  await executeRun(env, ids[0], fetchImpl);
  assert.equal(calls, 1);
  assert.equal(store.run(ids[0]).status, 'completed');
  assert.equal((await workspace.result(store.run(ids[0]))).html, html);
  assert.equal(store.run(ids[0]).html, null); // Large artifacts stay in R2.
  await workspace.alarm();
  assert.equal(jobs.size, 3);
  await workspace.cancel(store.run(ids[1]));
  await executeRun(env, ids[1], fetchImpl);
  assert.equal(calls, 1);
  assert.equal(store.run(ids[1]).status, 'cancelled');
});

test('hosted run API selects historical versions without locking the newest draft', async t => {
  const { store, workspace } = fixture(t);
  const prompt = store.createPrompt({ title: 'Original', category: 'Test', content: 'Original text' });
  store.enqueue([prompt.id], ['test/model']);
  const latest = store.editPrompt(prompt.id, { title: 'Latest', category: 'Test', content: 'Latest text', baseVersionId: prompt.version_id });
  const body = { promptIds: [prompt.id], modelIds: ['test/model'], promptVersions: { [prompt.id]: prompt.version_id } };
  const response = await workspace.fetch(request('/api/runs', body));
  assert.equal(response.status, 201);
  const run = store.run((await response.json()).ids[0]);
  assert.equal(run.version_id, prompt.version_id);
  assert.equal(run.prompt_content, prompt.content);
  assert.equal(store.prompt(prompt.id).locked_at, null);
  assert.equal((await workspace.fetch(request('/api/runs', { ...body, promptVersions: { [prompt.id]: 'missing' } }))).status, 400);
  delete body.promptVersions;
  const next = await workspace.fetch(request('/api/runs', body));
  assert.equal(store.run((await next.json()).ids[0]).version_id, latest.version_id);
});

test('hosted API validates effort variants before locking or enqueuing prompts', async t => {
  const { store, workspace } = fixture(t);
  workspace.models = async () => [{ id: 'test/model', reasoningEfforts: ['medium', 'high'] }];
  const prompt = store.createPrompt({ title: 'Matrix', category: 'Test', content: 'Build' });
  const post = modelVariants => workspace.fetch(request('/api/runs', { promptIds: [prompt.id], modelVariants }));
  assert.equal((await post([{ modelId: 'test/model', reasoningEffort: 'none' }])).status, 400);
  assert.equal(store.prompt(prompt.id).locked_at, null);
  assert.equal(store.runs().length, 0);
  const result = await post([{ modelId: 'test/model', reasoningEffort: 'medium' }, { modelId: 'test/model', reasoningEffort: 'high' }]);
  assert.equal(result.status, 201);
  const runs = (await result.json()).ids.map(id => store.run(id));
  assert.deepEqual(runs.map(r => r.config.reasoningEffort), ['medium', 'high']);
  assert.equal(runs[0].batch_id, runs[1].batch_id);
});

test('a failed artifact write cannot cause another model request', async t => {
  const { store, workspace, env, jobs } = fixture(t);
  const p = store.createPrompt({ title: 'Test', category: 'Test', content: 'Build' });
  const id = store.enqueue([p.id], ['test/model']).ids[0];
  await workspace.alarm();
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ choices: [{ message: { content: html } }] }); };
  env.OUTPUTS.put = async () => { throw Error('Storage unavailable'); };
  await assert.rejects(executeRun(env, id, fetchImpl));
  await executeRun(env, id, fetchImpl);
  assert.equal(calls, 1);
  jobs.set(id, 'complete');
  await workspace.alarm();
  assert.equal(store.run(id).status, 'interrupted');
});

test('cloud generation preserves truncation metrics and redacts provider errors', async () => {
  const run = { config: { timeoutSeconds: 30, systemPrompt: 'HTML', maxTokens: 1000 }, model_id: 'test', prompt_content: 'Build' };
  const truncated = await generate(run, 'secret', async () => Response.json({ choices: [{ message: { content: html }, finish_reason: 'length' }], usage: { cost: 1 } }));
  assert.equal(truncated.status, 'failed'); assert.equal(truncated.metrics.cost, 1); assert.equal(truncated.raw, html);
  const failure = await generate(run, 'secret', async () => Response.json({ error: { message: 'Bad secret' } }, { status: 401 }));
  assert.ok(!failure.error.includes('secret'));
});

test('Access verifies signature, audience, expiry and issuer; keys are encrypted', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test' };
  const env = { ACCESS_ISSUER: 'https://unit-test.cloudflareaccess.com', ACCESS_AUD: 'admin' };
  const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  async function token(patch = {}) {
    const data = enc({ alg: 'RS256', kid: 'test' }) + '.' + enc({ iss: env.ACCESS_ISSUER, aud: ['admin'], iat: Date.now()/1000, exp: Date.now()/1000+60, ...patch });
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data));
    return data + '.' + Buffer.from(signature).toString('base64url');
  }
  const req = jwt => new Request('https://admin.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
  const fetchKeys = async () => Response.json({ keys: [jwk] });
  await authenticate(req(await token()), env, fetchKeys);
  for (const patch of [{ exp: 1 }, { aud: ['other'] }, { iss: 'https://evil.test' }])
    await assert.rejects(authenticate(req(await token(patch)), env, fetchKeys));
  const valid = await token();
  await assert.rejects(authenticate(req(valid.slice(0, -4) + 'aaaa'), env, fetchKeys));
  await assert.rejects(authenticate(req(valid), {}, fetchKeys));
  const secret = '32-character-secret-key-for-test-only';
  const encrypted = await seal('sk-or-hidden', secret);
  assert.ok(!encrypted.includes('sk-or-hidden'));
  assert.equal(await unseal(encrypted, secret), 'sk-or-hidden');
  await assert.rejects(unseal(encrypted, secret + 'wrong'));
});

test('cloud router protects admin and alternate hosts; gallery publishes completed results only', async t => {
  const { env, workspace, store } = fixture(t);
  const verify = async () => { throw Object.assign(Error('Unauthorized'), { status: 401 }); };
  const assets = { '/': { body: 'admin', type: 'text/html' } };
  assert.equal((await route(new Request(env.ADMIN_ORIGIN), env, assets, verify)).status, 401);
  assert.equal((await route(new Request('https://other.workers.dev/api/state'), env, assets, async () => {})).status, 404);
  const cross = new Request(env.ADMIN_ORIGIN + '/api/prompts', { method: 'POST', headers: { Origin: 'https://evil.test' } });
  assert.equal((await route(cross, env, assets, async () => {})).status, 403);
  const p = store.createPrompt({ title: 'Test', category: 'Test', content: 'Build' });
  const id = store.enqueue([p.id], ['test/model']).ids[0];
  store.updateRun(id, { status: 'completed' });
  await env.OUTPUTS.put(`runs/${id}.json`, JSON.stringify({ html, raw: 'private original' }));
  store.enqueue([p.id], ['test/model']);
  env.PUBLIC_GALLERY = 'true';
  const response = await route(new Request('https://api.example.com/api/gallery', { headers: { Origin: env.GALLERY_ORIGIN } }), env, assets, verify);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.GALLERY_ORIGIN);
  const gallery = await response.json();
  assert.equal(gallery.runs.length, 1); assert.equal(gallery.runs[0].html, html);
  assert.ok(!JSON.stringify(gallery).includes('private original'));
  assert.ok(!JSON.stringify(gallery).includes(env.OPENROUTER_API_KEY));
  await workspace.saveKey('sk-or-new');
  const state = await (await workspace.fetch(new Request(env.ADMIN_ORIGIN + '/api/state'))).json();
  assert.ok(!JSON.stringify(state).includes('sk-or-new'));
});

test('resumable migration preserves historical data and never replays imported jobs', async t => {
  const { workspace, env, store } = fixture(t);
  env.ALLOW_IMPORT = 'true';
  const snapshotId = 'test-migration', now = new Date().toISOString();
  const send = body => workspace.fetch(request('/api/import', { snapshotId, ...body }));
  const start = { phase: 'start', runCount: 1, settings: store.settings(),
    prompts: [{ id: 'p', archived: 0, created_at: now }],
    versions: [{ id: 'v', prompt_id: 'p', version: 1, title: 'History', category: 'Test', content: 'Original', locked_at: now, updated_at: now }] };
  assert.equal((await send(start)).status, 200);
  assert.equal((await send(start)).status, 200);
  assert.equal((await workspace.fetch(request('/api/prompts', { title: 'Blocked' }))).status, 409);
  const run = { id: 'r', version_id: 'v', batch_id: 'b', model_id: 'test/model', model_name: 'Test', created_at: now,
    status: 'queued', config: JSON.stringify({ timeoutSeconds: 30 }), html, raw: html, metrics: JSON.stringify({ cost: 0.5 }) };
  assert.equal((await send({ phase: 'run', run })).status, 200);
  assert.equal((await send({ phase: 'run', run })).status, 200);
  assert.equal((await send({ phase: 'finish' })).status, 200);
  assert.equal(store.runs().length, 1);
  assert.equal(store.run('r').status, 'interrupted');
  assert.equal(store.run('r').metrics.cost, 0.5);
  assert.equal((await workspace.result(store.run('r'))).raw, html);
  assert.equal(store.prompt('p').versions.length, 1);
  env.ALLOW_IMPORT = 'false';
  assert.equal((await send(start)).status, 403);
});

test('deployment uploads unchanged source modules with a complete dependency graph', () => {
  const config = JSON.parse(readFileSync('cloudflare/config.example.json'));
  const { modules, metadata } = deployment(config, true);
  const names = new Set(modules.map(m => m.name));
  for (const module of modules.filter(m => m.type.includes('javascript'))) {
    for (const match of module.source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('cloudflare:')) continue;
      const target = posix.normalize(posix.join(posix.dirname(module.name), match[1]));
      assert.ok(names.has(target), `Missing ${target}`);
    }
  }
  assert.equal(metadata.bindings.find(b => b.type === 'workflow').class_name, 'BenchmarkRun');
  assert.deepEqual(metadata.migrations.new_sqlite_classes, ['Workspace']);
});
