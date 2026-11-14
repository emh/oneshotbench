import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/app.mjs';
import { extractHtml, safeDocument, OUTPUT_INSTRUCTIONS } from '../server/format.mjs';

const models = [
  {
    id: 'test/a',
    name: 'Model A',
    context_length: 32000,
    pricing: { prompt: '0', completion: '0' },
  },
  {
    id: 'test/b',
    name: 'Model B',
    context_length: 32000,
    pricing: { prompt: '0', completion: '0' },
  },
];
const html =
  '<!DOCTYPE html><html><body><button onclick="this.textContent=\'done\'">Try it</button></body></html>';
const fixture = () => {
  const store = new Store(':memory:', { seed: false });
  store.saveSettings({ selectedModels: models });
  const prompt = store.createPrompt({
    title: 'Test prompt',
    category: 'Test',
    content: 'Build a counter.',
  });
  return { store, prompt };
};
const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const response = (content = html, extra = {}) =>
  Response.json({
    id: 'generation-test',
    provider: 'Test provider',
    model: 'test/a',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40, cost: 0.001 },
    ...extra,
  });

test('drafts edit in place; run submission freezes versions and configuration', () => {
  const { store, prompt } = fixture();
  const draft = store.editPrompt(prompt.id, {
    title: 'Edited',
    category: 'Test',
    content: 'Build a chart.',
    baseVersionId: prompt.version_id,
  });
  assert.equal(draft.version, 1);
  assert.equal(draft.version_id, prompt.version_id);
  const batch = store.enqueue(
    [prompt.id],
    models.map((m) => m.id),
  );
  assert.equal(batch.ids.length, 2);
  assert.ok(store.prompt(prompt.id).locked_at);
  const version2 = store.editPrompt(prompt.id, {
    title: 'Edited again',
    category: 'Test',
    content: 'Build a better chart.',
    baseVersionId: draft.version_id,
  });
  assert.equal(version2.version, 2);
  assert.equal(version2.locked_at, null);
  assert.equal(version2.versions.length, 2);
  assert.equal(store.run(batch.ids[0]).prompt_content, 'Build a chart.');
  assert.equal(store.run(batch.ids[0]).prompt_title, 'Edited');
  store.saveSettings({ temperature: 1.5, systemPrompt: 'Changed instructions' });
  assert.equal(store.run(batch.ids[0]).config.temperature, 0.7);
  assert.notEqual(store.run(batch.ids[0]).config.systemPrompt, 'Changed instructions');
  assert.throws(
    () =>
      store.editPrompt(prompt.id, {
        title: 'Stale',
        category: 'Test',
        content: 'Stale',
        baseVersionId: draft.version_id,
      }),
    /newer version/,
  );
  const noChange = store.editPrompt(prompt.id, {
    title: version2.title,
    category: version2.category,
    content: version2.content,
    baseVersionId: version2.version_id,
  });
  assert.equal(noChange.version, 2);
  store.close();
});
test('preview dimensions do not alter system instructions or historical run snapshots', () => {
  const { store, prompt } = fixture();
  assert.doesNotMatch(OUTPUT_INSTRUCTIONS, /1200|900|viewport/i);
  const instructions = 'Return standalone HTML.\nKeep the design responsive.';
  store.saveSettings({ systemPrompt: instructions, minWidth: 1600, minHeight: 1000 });
  const first = store.enqueue([prompt.id], [models[0].id]);
  assert.equal(store.run(first.ids[0]).config.systemPrompt, instructions);
  store.saveSettings({ minWidth: 2000, minHeight: 1400 });
  const second = store.enqueue([prompt.id], [models[0].id]);
  assert.equal(store.run(second.ids[0]).config.systemPrompt, instructions);
  assert.equal(store.run(first.ids[0]).config.previewMinWidth, 1600);
  assert.equal(store.run(second.ids[0]).config.previewMinWidth, 2000);
  store.saveSettings({ systemPrompt: 'New instructions' });
  assert.equal(store.run(first.ids[0]).config.systemPrompt, instructions);
  store.close();
});
test('explicit versions rerun historical prompts and defaults still select latest', () => {
  const { store, prompt } = fixture();
  store.enqueue([prompt.id], ['test/a']);
  const originalLock = store.prompt(prompt.id).locked_at;
  const latest = store.editPrompt(prompt.id, { title: 'Version two', category: 'Changed',
    content: 'Build the new version.', baseVersionId: prompt.version_id });
  const other = store.createPrompt({ title: 'Other', category: 'Test', content: 'Other prompt' });
  const before = store.runs().length;
  for (const versions of [null, [], 'v1', { [prompt.id]: 1 }, { extra: prompt.version_id },
    { [prompt.id]: 'missing' }, { [prompt.id]: other.version_id }]) {
    assert.throws(() => store.enqueue([other.id, prompt.id], ['test/a'], {}, versions));
    assert.equal(store.runs().length, before);
    assert.equal(store.prompt(other.id).locked_at, null);
    assert.equal(store.prompt(prompt.id).locked_at, null);
  }
  const batch = store.enqueue([prompt.id, other.id], ['test/a', 'test/b'], {}, { [prompt.id]: prompt.version_id });
  assert.equal(batch.ids.length, 4);
  const historical = store.run(batch.ids[0]);
  assert.equal(historical.version_id, prompt.version_id);
  assert.equal(historical.prompt_content, prompt.content);
  assert.equal(historical.prompt_title, prompt.title);
  assert.equal(store.prompt(prompt.id).locked_at, null);
  assert.equal(store.prompt(prompt.id).versions[1].locked_at, originalLock);
  assert.equal(store.run(batch.ids[2]).version_id, other.version_id);
  const newest = store.enqueue([prompt.id], ['test/a']);
  assert.equal(store.run(newest.ids[0]).version_id, latest.version_id);
  assert.ok(store.prompt(prompt.id).locked_at);
  store.archivePrompt(prompt.id, true);
  assert.throws(() => store.enqueue([prompt.id], ['test/a'], {}, { [prompt.id]: prompt.version_id }));
  store.close();
});
test('invalid batches roll back without freezing drafts', () => {
  const { store, prompt } = fixture();
  assert.throws(() => store.enqueue([prompt.id], ['unknown/model']), /available prompts/);
  assert.equal(store.prompt(prompt.id).locked_at, null);
  assert.equal(store.runs().length, 0);
  store.close();
});
test('archiving preserves historical runs and prevents new launches', () => {
  const { store, prompt } = fixture();
  const batch = store.enqueue([prompt.id], ['test/a']);
  store.archivePrompt(prompt.id, true);
  assert.equal(store.prompts().length, 0);
  assert.equal(store.run(batch.ids[0]).prompt_title, 'Test prompt');
  assert.throws(() => store.enqueue([prompt.id], ['test/a']));
  store.close();
});
test('persistent recovery marks in-flight runs interrupted without replaying them', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oneshot-test-'));
  const path = resolve(dir, 'data.sqlite');
  let store = new Store(path, { seed: false });
  store.saveSettings({ selectedModels: models });
  const prompt = store.createPrompt({
    title: 'Recovery',
    category: 'Test',
    content: 'Build something',
  });
  const batch = store.enqueue(
    [prompt.id],
    models.map((m) => m.id),
  );
  store.updateRun(batch.ids[0], { status: 'running' });
  store.close();
  store = new Store(path, { seed: false });
  store.recover();
  assert.equal(store.run(batch.ids[0]).status, 'interrupted');
  assert.equal(store.run(batch.ids[1]).status, 'queued');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test('HTML extraction supports fences and rejects missing or incomplete documents', () => {
  assert.equal(extractHtml(`Here is your page:\n\`\`\`html\n${html}\n\`\`\``), html);
  assert.throws(() => extractHtml('plain explanation'), /did not return/);
  assert.throws(() => extractHtml('<!doctype html><html><body>truncated'), /incomplete/);
  assert.match(safeDocument(html), /connect-src 'none'/);
  assert.match(safeDocument(html), /Content-Security-Policy/);
});
test('runner sends one request per job, preserves exact messages, and records usage', async () => {
  const { store, prompt } = fixture();
  const batch = store.enqueue([prompt.id], ['test/a']);
  const requests = [];
  const runner = new Runner(store, {
    getKey: () => 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response();
    },
  });
  runner.pump();
  await waitFor(() => store.run(batch.ids[0]).status === 'completed');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, 'test/a');
  assert.equal(payload.messages[1].content, prompt.content);
  assert.equal(payload.messages[0].content, store.run(batch.ids[0]).config.systemPrompt);
  assert.equal(payload.provider.allow_fallbacks, false);
  const run = store.run(batch.ids[0]);
  assert.equal(run.metrics.cost, 0.001);
  assert.equal(run.metrics.totalTokens, 40);
  assert.equal(run.html, html);
  assert.equal(run.response_id, 'generation-test');
  store.close();
});
test('truncation and invalid HTML retain raw response and known charges', async () => {
  for (const [raw, extra, message] of [
    ['not HTML', {}, /HTML document/],
    [html, { choices: [{ message: { content: html }, finish_reason: 'length' }] }, /truncated/],
  ]) {
    const { store, prompt } = fixture();
    const { ids } = store.enqueue([prompt.id], ['test/a']);
    const runner = new Runner(store, {
      getKey: () => 'test-key',
      fetchImpl: async () => response(raw, extra),
    });
    runner.pump();
    await waitFor(() => store.run(ids[0]).status === 'failed');
    const run = store.run(ids[0]);
    assert.match(run.error, message);
    assert.equal(run.raw, raw);
    assert.equal(run.metrics.cost, 0.001);
    assert.equal(run.html, null);
    store.close();
  }
});
test('queue respects concurrency and cancelling queued or running jobs is terminal', async () => {
  const { store, prompt } = fixture();
  store.saveSettings({ concurrency: 1 });
  const { ids } = store.enqueue(
    [prompt.id],
    models.map((m) => m.id),
  );
  let calls = 0;
  const runner = new Runner(store, {
    getKey: () => 'test-key',
    fetchImpl: async (url, { signal }) => {
      calls++;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });
  runner.pump();
  assert.equal(calls, 1);
  assert.equal(store.run(ids[1]).status, 'queued');
  runner.cancel(ids[1]);
  runner.cancel(ids[0]);
  await waitFor(() => runner.active.size === 0);
  assert.equal(calls, 1);
  assert.equal(store.run(ids[0]).status, 'cancelled');
  assert.equal(store.run(ids[1]).status, 'cancelled');
  store.close();
});
test('provider failures are not retried and credentials are redacted', async () => {
  const { store, prompt } = fixture();
  const { ids } = store.enqueue([prompt.id], ['test/a']);
  let calls = 0;
  const runner = new Runner(store, {
    getKey: () => 'sensitive-key',
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: { message: 'Invalid sensitive-key' } }, { status: 401 });
    },
  });
  runner.pump();
  await waitFor(() => store.run(ids[0]).status === 'failed');
  assert.equal(calls, 1);
  assert.ok(!store.run(ids[0]).error.includes('sensitive-key'));
  store.close();
});

test('admin API validates input, protects mutations, and never returns credentials', async (t) => {
  const { store, prompt } = fixture();
  const key = 'sk-or-secret-testing-key';
  const runner = {
    pump() {},
    cancel() {
      return true;
    },
  };
  const app = createApp({ store, runner, getKey: () => key });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => {
    app.close();
    store.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const prefix of ['', '/gallery']) {
    for (const [path, source] of [
      ['/', `apps/${prefix ? 'gallery' : 'admin'}/index.html`],
      ['/app/main.js', `apps/${prefix ? 'gallery' : 'admin'}/main.js`],
      ['/shared/dom.js', 'apps/shared/dom.js'],
      ['/shared/styles.css', 'apps/shared/styles.css'],
    ]) {
      const response = await fetch(`${base}${prefix}${path}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), readFileSync(resolve(source), 'utf8'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  for (const path of ['/.env', '/server/store.mjs', '/gallery/../package.json'])
    assert.equal((await fetch(base + path)).status, 404);
  const request = (path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin', ...headers },
      body: JSON.stringify(body),
    });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.keyConfigured, true);
  assert.ok(!JSON.stringify(state).includes(key));
  const missingHeader = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingHeader.status, 403);
  const cross = await request('/api/runs', {}, { Origin: 'https://attacker.example' });
  assert.equal(cross.status, 403);
  assert.equal(
    (await request('/api/runs', { promptIds: [prompt.id], modelIds: ['not-enabled'] })).status,
    400,
  );
  assert.equal((await request('/api/runs', { promptIds: [], modelIds: ['test/a'] })).status, 400);
  assert.equal(
    (await request('/api/runs', { promptIds: [prompt.id], modelIds: ['test/a'], maxTokens: -1 }))
      .status,
    400,
  );
  const result = await request('/api/runs', {
    promptIds: [prompt.id, prompt.id],
    modelIds: ['test/a', 'test/a'],
  });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).ids.length, 1);
  store.editPrompt(prompt.id, { title: 'Next', category: 'Test', content: 'New content', baseVersionId: prompt.version_id });
  const rerun = await request('/api/runs', { promptIds: [prompt.id], modelIds: ['test/a'],
    promptVersions: { [prompt.id]: prompt.version_id } });
  assert.equal(rerun.status, 201);
  assert.equal(store.run((await rerun.json()).ids[0]).prompt_content, prompt.content);
  assert.equal(store.prompt(prompt.id).locked_at, null);
  assert.equal((await request('/api/runs', { promptIds: [prompt.id], modelIds: ['test/a'],
    promptVersions: { [prompt.id]: 'missing' } })).status, 400);
  const gallery = await (await fetch(`${base}/api/gallery`)).json();
  assert.equal(gallery.runs.length, 0);
  assert.ok(!('selectedModels' in gallery.settings));
});
test('local retry API requires authorization and a key, then queues a retry in its original batch', async t => {
  const { store, prompt } = fixture();
  const original = store.enqueue([prompt.id], ['test/a']);
  const id = original.ids[0];
  store.updateRun(id, { status: 'failed', error: 'Provider failure' });
  let key = null, pumps = 0;
  const app = createApp({ store, runner: { pump() { pumps++; } }, getKey: () => key });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.close(); store.close(); });
  const url = `http://127.0.0.1:${app.address().port}/api/runs/${id}/retry`;
  const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post({})).status, 403);
  const auth = { 'X-Oneshot-Client': 'admin' };
  assert.equal((await post(auth)).status, 400);
  assert.equal(store.runs().length, 1);
  key = 'fixture-key';
  assert.equal((await post({ ...auth, Origin: 'https://attacker.example' })).status, 403);
  const response = await post(auth);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.batchId, original.batchId);
  assert.equal(store.run(result.ids[0]).status, 'queued');
  assert.equal(store.run(id).status, 'failed');
  assert.equal(pumps, 1);
});
test('local API supports large token settings and bulk retries across batches', async t => {
  const { store, prompt } = fixture();
  let pumps = 0;
  const app = createApp({ store, runner: { pump() { pumps++; } }, getKey: () => 'fixture-key' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method, body) => fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin' }, body: JSON.stringify(body) });
  assert.equal((await request('/api/settings', 'PATCH', { maxTokens: 262144 })).status, 200);
  const batches = [];
  for (const maxTokens of [262144, 1048576]) {
    const response = await request('/api/runs', 'POST', { promptIds: [prompt.id], modelIds: ['test/a'], maxTokens });
    assert.equal(response.status, 201);
    const batch = await response.json();
    assert.equal(store.run(batch.ids[0]).config.maxTokens, maxTokens);
    store.updateRun(batch.ids[0], { status: 'failed' });
    batches.push(batch);
  }
  const pumpsBeforeRetry = pumps;
  const response = await request('/api/runs/retry', 'POST', { ids: batches.flatMap(b => b.ids) });
  assert.equal(response.status, 201);
  (await response.json()).ids.forEach((id, index) => {
    assert.equal(store.run(id).batch_id, batches[index].batchId);
    assert.equal(store.run(id).config.maxTokens, 262144);
  });
  assert.equal(pumps, pumpsBeforeRetry + 1);
});
test('bulk delete API protects mutations, cancels active runs, and removes results without unlocking prompts', async t => {
  const { store, prompt } = fixture();
  const runner = new Runner(store, { getKey: () => null });
  const ids = store.enqueue([prompt.id], models.map(m => m.id)).ids;
  store.updateRun(ids[0], { status: 'completed', html, raw: html });
  const app = createApp({ store, runner, getKey: () => null });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { runner.stop(); app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const remove = (body, headers = {}) => fetch(base + '/api/runs', { method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await remove({ ids })).status, 403);
  const auth = { 'X-Oneshot-Client': 'admin' };
  assert.equal((await remove({ ids }, { ...auth, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await remove({ ids: [null] }, auth)).status, 400);
  assert.equal(store.runs().length, 2);
  const response = await remove({ ids: [...ids, ids[0]] }, auth);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).deleted, ids);
  assert.equal(store.runs().length, 0);
  assert.ok(store.prompt(prompt.id).locked_at);
  assert.equal(store.prompt(prompt.id).run_count, 0);
  assert.equal((await fetch(base + '/api/runs/' + ids[0])).status, 404);
  assert.equal((await (await fetch(base + '/api/gallery')).json()).runs.length, 0);
  assert.deepEqual((await (await remove({ ids }, auth)).json()).deleted, []);
});
test('direct preview responses enforce CSP and sandbox even outside the gallery', async (t) => {
  const { store, prompt } = fixture();
  const { ids } = store.enqueue([prompt.id], ['test/a']);
  store.updateRun(ids[0], { status: 'completed', html, raw: html });
  const app = createApp({ store, runner: { pump() {} }, getKey: () => 'private-key' });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => {
    app.close();
    store.close();
  });
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/runs/${ids[0]}/html`);
  assert.match(res.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(res.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await res.text(), /Content-Security-Policy/);
});
test('gallery export is standalone, completed-only, and excludes private configuration', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oneshot-export-'));
  writeFileSync(resolve(dir, '.env'), 'OPENROUTER_API_KEY=do-not-export-me');
  const store = new Store(resolve(dir, 'data/oneshot.sqlite'), { seed: false });
  store.saveSettings({ selectedModels: models });
  const p = store.createPrompt({ title: 'Export', category: 'Test', content: 'Build a page' });
  const { ids } = store.enqueue(
    [p.id],
    models.map((m) => m.id),
  );
  store.updateRun(ids[0], { status: 'completed', html, raw: html });
  store.close();
  const result = spawnSync(process.execPath, [resolve('scripts/export-gallery.mjs')], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(resolve(dir, 'exports/gallery/data.json'), 'utf8');
  const data = JSON.parse(output);
  assert.equal(data.mode, 'static');
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].html, html);
  assert.ok(!('raw' in data.runs[0]));
  assert.ok(!('selectedModels' in data.settings));
  assert.ok(!output.includes('do-not-export-me'));
  assert.match(
    readFileSync(resolve(dir, 'exports/gallery/index.html'), 'utf8'),
    /meta name="oneshot-export"/,
  );
  for (const file of ['app/main.js', 'shared/dom.js', 'shared/styles.css'])
    assert.ok(readFileSync(resolve(dir, 'exports/gallery', file), 'utf8').length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('API key replacement preserves other environment variables without returning the key', async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oneshot-key-'));
  const envPath = resolve(dir, '.env');
  writeFileSync(
    envPath,
    '# Local settings\nOPENROUTER_API_KEY=sk-or-old\nANOTHER_SETTING=preserved\n',
  );
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-old';
  const { store } = fixture();
  const app = createApp({ store, runner: { pump() {} }, envPath });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => {
    app.close();
    store.close();
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin' },
    body: JSON.stringify({ apiKey: 'sk-or-new-secret' }),
  });
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes('sk-or-new-secret'));
  assert.equal(process.env.OPENROUTER_API_KEY, 'sk-or-new-secret');
  const contents = readFileSync(envPath, 'utf8');
  assert.match(contents, /ANOTHER_SETTING=preserved/);
  assert.match(contents, /OPENROUTER_API_KEY=sk-or-new-secret/);
  assert.ok(!contents.includes('sk-or-old'));
});
