import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/app.mjs';
import { extractHtml, safeDocument } from '../server/format.mjs';

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
  const gallery = await (await fetch(`${base}/api/gallery`)).json();
  assert.equal(gallery.runs.length, 0);
  assert.ok(!('selectedModels' in gallery.settings));
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
