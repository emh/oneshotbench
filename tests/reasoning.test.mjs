import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Runner } from '../server/runner.mjs';
import { catalogModel, variants, validateEfforts, effortLevels } from '../server/reasoning.mjs';
import { generate } from '../cloudflare/generate.mjs';
import { runModelName, tokenUsage } from '../apps/shared/dom.js';
const html = '<!doctype html><html><body>Test</body></html>';
const usage = { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100,
  completion_tokens_details: { reasoning_tokens: 200 } };

test('reasoning controls follow per-model metadata, including missing, null and mandatory values', async () => {
  assert.deepEqual(catalogModel({}).reasoningEfforts, []);
  assert.deepEqual(catalogModel({ reasoning: { supported_efforts: ['high', 'medium', 'none'], mandatory: true } }).reasoningEfforts, ['medium', 'high']);
  assert.deepEqual(catalogModel({ reasoning: { supported_efforts: null } }).reasoningEfforts, effortLevels);
  assert.deepEqual(catalogModel({ reasoning: { supported_efforts: ['unknown', 'high'] } }).reasoningEfforts, ['high']);
  const catalog = [{ id: 'test/a', reasoningEfforts: ['medium', 'high'] }];
  const load = async () => catalog;
  await validateEfforts(variants([{ modelId: 'test/a', reasoningEffort: 'high' }]), catalog, load);
  await assert.rejects(validateEfforts(variants([{ modelId: 'test/a', reasoningEffort: 'none' }]), catalog, load));
  await assert.rejects(validateEfforts(variants([{ modelId: 'disabled', reasoningEffort: 'high' }]), catalog, load));
  await validateEfforts(variants(['test/a']), catalog, () => { throw Error('Defaults do not need capability lookup'); });
  for (const bad of [[], [null], [{ modelId: 'test/a', reasoningEffort: 'bogus' }]]) assert.throws(() => variants(bad));
});

test('prompt × model effort batches preserve settings and send one request per variant', async t => {
  const store = new Store(':memory:', { seed: false });
  t.after(() => store.close());
  store.saveSettings({ selectedModels: [{ id: 'test/a', name: 'Astra' }, { id: 'test/b', name: 'Other' }], temperature: 0.3, maxTokens: 12345 });
  const prompts = ['One', 'Two'].map(title => store.createPrompt({ title, category: 'Test', content: title }));
  const choices = [{ modelId: 'test/a', reasoningEffort: 'medium' }, { modelId: 'test/a', reasoningEffort: 'high' }, { modelId: 'test/b' }];
  assert.throws(() => store.enqueue(Array(101).fill(prompts[0].id), choices), /200/);
  assert.equal(store.prompt(prompts[0].id).locked_at, null);
  const batch = store.enqueue(prompts.map(p => p.id), [...choices, choices[0]]);
  assert.equal(batch.ids.length, 6);
  const bodies = [];
  const runner = new Runner(store, { getKey: () => 'fixture-key', fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: html }, finish_reason: 'stop' }], usage });
  } });
  store.saveSettings({ temperature: 1, maxTokens: 256 });
  for (const id of batch.ids) await runner.execute(store.run(id), new AbortController());
  assert.deepEqual(bodies.map(b => b.reasoning?.effort), ['medium', 'high', undefined, 'medium', 'high', undefined]);
  for (const body of bodies) { assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 12345); }
  assert.equal(runModelName(store.run(batch.ids[0])), 'Astra · medium');
  assert.equal(runModelName(store.run(batch.ids[1])), 'Astra · high');
  assert.equal(store.runs({ completed: true }).length, 6);
  assert.equal(store.run(batch.ids[0]).metrics.reasoningTokens, 200);
});

test('Cloudflare generation transmits explicit effort and omits the parameter for defaults', async () => {
  for (const effort of [undefined, 'none', 'medium', 'high']) {
    let body;
    const result = await generate({ model_id: 'test/a', prompt_content: 'Build', config: {
      timeoutSeconds: 30, temperature: 0.3, maxTokens: 5000, systemPrompt: 'HTML',
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    } }, 'fixture-key', async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: html }, finish_reason: 'stop' }], usage });
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.metrics.reasoningTokens, 200);
    if (effort === undefined) assert.ok(!('reasoning' in body));
    else assert.deepEqual(body.reasoning, { effort });
  }
});

test('token usage distinguishes unknown, zero, partial and reasoning counts without double counting', () => {
  assert.equal(tokenUsage(), '—');
  assert.equal(tokenUsage(null), '—');
  assert.equal(tokenUsage({ inputTokens: 0, outputTokens: 0 }), '0 in / 0 out');
  assert.equal(tokenUsage({ inputTokens: 100 }), '100 in');
  assert.equal(tokenUsage({ totalTokens: 1100 }), (1100).toLocaleString() + ' total');
  assert.equal(tokenUsage({ inputTokens: 100, outputTokens: 1000, reasoningTokens: 200, totalTokens: 1100 }),
    '100 in / ' + (1000).toLocaleString() + ' out / 200 reasoning');
});
