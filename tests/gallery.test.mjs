import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryURL, readGalleryURL, matchesRun, tokenCount, plotData } from '../apps/shared/gallery.js';
import { Store } from '../server/store.mjs';

test('gallery links round-trip filters, special model IDs, and single/multiple result routes', () => {
  const state = { view: 'scatter', prompt: 'p', model: '~qwen/a+b:free', effort: 'high', version: '2',
    batch: 'batch', status: 'failed', metric: 'reasoning', compare: [], columns: null };
  const url = galleryURL('https://example.com/project/?old=value#stale', state);
  assert.equal(url.pathname, '/project/');
  assert.deepEqual(readGalleryURL(url.search), state);
  assert.equal(url.hash, '');
  assert.equal(readGalleryURL(galleryURL(url, { compare: ['a'] }).search).compare[0], 'a');
  assert.equal(galleryURL(url, { compare: ['a'] }).search, '?run=a');
  assert.deepEqual(readGalleryURL('?compare=a,a,b&columns=3').compare, ['a', 'b']);
  assert.equal(readGalleryURL('?columns=100&tokens=bogus&view=unknown').columns, null);
  assert.equal(readGalleryURL('?columns=100&tokens=bogus&view=unknown').metric, 'total');
  assert.equal(readGalleryURL('?compare=' + Array.from({ length: 12 }, (_, i) => i).join(',')).compare.length, 9);
});

test('plot data retains zero cost, excludes missing metrics, and never double-counts reasoning tokens', () => {
  const base = { id: 'a', prompt_id: 'p', model_id: 'model', version: 2, batch_id: 'b', status: 'completed',
    config: { reasoningEffort: 'high' }, metrics: { cost: 0, inputTokens: 100, outputTokens: 400, reasoningTokens: 300 } };
  assert.equal(tokenCount(base), 500);
  assert.equal(tokenCount(base, 'reasoning'), 300);
  assert.equal(tokenCount({ metrics: { totalTokens: 0 } }), 0);
  assert.equal(tokenCount({ metrics: { inputTokens: 100 } }), null);
  const noCost = { ...base, id: 'missing', metrics: { totalTokens: 100 } };
  const failed = { ...base, id: 'failed', status: 'failed', config: {}, metrics: { totalTokens: 400, cost: .03 } };
  assert.deepEqual(plotData([base, noCost, failed], {}, 'total').points.map(p => p.run.id), ['a', 'failed']);
  assert.equal(plotData([base, noCost, failed], {}, 'total').missing, 1);
  assert.equal(plotData([base, noCost, failed], { status: 'failed', effort: 'default' }, 'total').points.length, 1);
  assert.ok(matchesRun(base, { prompt: 'p', model: 'model', effort: 'high', version: '2', batch: 'b', status: 'completed' }));
  assert.ok(!matchesRun(base, { version: '1' }));
  assert.ok(!matchesRun(base, { effort: 'default' }));
});

test('public prompt index includes unused prompts and analytics omit private run payloads', t => {
  const store = new Store(':memory:', { seed: false });
  t.after(() => store.close());
  store.saveSettings({ selectedModels: [{ id: 'm', name: 'Model' }], systemPrompt: 'private system marker' });
  const p = store.createPrompt({ title: 'Used', content: 'Version one' });
  const unused = store.createPrompt({ title: 'Unused', content: 'Draft' });
  const id = store.enqueue([p.id], [{ modelId: 'm', reasoningEffort: 'high' }]).ids[0];
  store.updateRun(id, { status: 'failed', raw: 'private raw marker', error: 'private error marker', metrics: { cost: .05, totalTokens: 500 } });
  store.editPrompt(p.id, { title: 'Used', content: 'Version two', baseVersionId: p.version_id });
  const index = store.galleryIndex();
  assert.equal(index.prompts.length, 2);
  assert.ok(index.prompts.some(p => p.id === unused.id));
  assert.equal(index.prompts.find(prompt => prompt.id === p.id).versions.length, 2);
  assert.equal(index.analytics[0].status, 'failed');
  assert.deepEqual(index.analytics[0].config, { reasoningEffort: 'high' });
  assert.equal(index.analytics[0].metrics.cost, .05);
  assert.doesNotMatch(JSON.stringify(index), /private (system|raw|error) marker/);
});
