import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryURL, readGalleryURL, matchesRun, tokenCount, plotData, hasGalleryFilters, clearGalleryFilters } from '../apps/shared/gallery.js';
import { Store } from '../server/store.mjs';

test('gallery links round-trip filters, special model IDs, and single/multiple result routes', () => {
  const state = { view: 'scatter', prompt: 'p', model: '~qwen/a+b:free', effort: 'high', version: '2',
    batch: 'batch', status: 'failed', metric: 'reasoning', compare: [], columns: null,
    axes: 'time-tokens', hiddenModels: ['~qwen/a+b:free', 'provider/model,variant'] };
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
  assert.equal(readGalleryURL('?axes=unknown').axes, 'cost-tokens');
  assert.deepEqual(readGalleryURL('?hideModel=m&hideModel=m&hideModel=').hiddenModels, ['m']);
});

test('scatterplot axis pairs use recorded seconds and only require the selected metrics', () => {
  const runs = [
    { id: 'all', model_id: 'a', model_name: 'A', metrics: { durationMs: 12500, totalTokens: 100, cost: .2 } },
    { id: 'no-cost', model_id: 'b', model_name: 'B', metrics: { durationMs: 0, totalTokens: 0 } },
    { id: 'no-tokens', model_id: 'a', model_name: 'A', metrics: { durationMs: 2000, cost: 0 } },
    { id: 'no-time', model_id: 'c', model_name: 'C', metrics: { totalTokens: 50, cost: .1 } },
  ];
  const values = axes => plotData(runs, { axes }, 'total').points.map(p => [p.run.id, p.x, p.y]);
  assert.deepEqual(values('cost-tokens'), [['all', 100, .2], ['no-time', 50, .1]]);
  assert.deepEqual(values('cost-time'), [['all', 12.5, .2], ['no-tokens', 2, 0]]);
  assert.deepEqual(values('time-tokens'), [['all', 100, 12.5], ['no-cost', 0, 0]]);
  const hidden = plotData(runs, { axes: 'cost-time', hiddenModels: ['a'] }, 'total');
  assert.equal(hidden.points.length, 0);
  assert.deepEqual(hidden.models, [['a', 'A'], ['b', 'B'], ['c', 'C']]);
  assert.equal(hidden.missing, 2);
  const allHidden = plotData(runs, { hiddenModels: ['a', 'b', 'c'] }, 'total');
  assert.equal(allHidden.points.length, 0);
  assert.equal(allHidden.missing, 0);
  assert.equal(allHidden.models.length, 3);
});

test('clear all removes filters and hidden models while retaining chart and comparison choices', () => {
  const state = readGalleryURL('?view=scatter&prompt=p&model=m&effort=high&version=2&batch=b&status=failed&hideModel=a&axes=time-tokens&tokens=reasoning&columns=2');
  assert.ok(hasGalleryFilters(state));
  const cleared = clearGalleryFilters(state);
  assert.equal(hasGalleryFilters(cleared), false);
  assert.equal(galleryURL('https://example.com/gallery/', cleared).search, '?view=scatter&columns=2&tokens=reasoning&axes=time-tokens');
  assert.ok(hasGalleryFilters({ hiddenModels: ['a'] }));
  assert.equal(hasGalleryFilters({ axes: 'cost-time', metric: 'output' }), false);
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
