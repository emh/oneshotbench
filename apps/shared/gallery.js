export const filterKeys = ['prompt', 'model', 'effort', 'version', 'batch', 'status'];
export function readGalleryURL(search) {
  const params = new URLSearchParams(search);
  const compare = [...new Set((params.get('run') || params.get('compare') || '').split(',').filter(Boolean))].slice(0, 9);
  const columns = Number(params.get('columns'));
  return {
    ...Object.fromEntries(filterKeys.map(key => [key, params.get(key) || ''])), compare,
    view: ['prompts', 'scatter'].includes(params.get('view')) ? params.get('view') : 'gallery',
    metric: ['input', 'output', 'reasoning'].includes(params.get('tokens')) ? params.get('tokens') : 'total',
    columns: Number.isInteger(columns) && columns >= 1 && columns <= 9 ? columns : null,
  };
}
export function galleryURL(base, state) {
  const url = new URL(base);
  url.search = ''; url.hash = '';
  if (state.view && state.view !== 'gallery') url.searchParams.set('view', state.view);
  for (const key of filterKeys) if (state[key]) url.searchParams.set(key, state[key]);
  const ids = [...new Set(state.compare || [])].slice(0, 9);
  if (ids.length) url.searchParams.set(ids.length === 1 ? 'run' : 'compare', ids.join(','));
  if (state.columns) url.searchParams.set('columns', state.columns);
  if (state.metric && state.metric !== 'total') url.searchParams.set('tokens', state.metric);
  return url;
}
export function matchesRun(run, filters) {
  return (!filters.prompt || run.prompt_id === filters.prompt) &&
    (!filters.model || run.model_id === filters.model) &&
    (!filters.effort || (run.config?.reasoningEffort ?? 'default') === filters.effort) &&
    (!filters.version || String(run.version) === filters.version) &&
    (!filters.batch || run.batch_id === filters.batch) &&
    (!filters.status || run.status === filters.status);
}
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function tokenCount(run, metric = 'total') {
  const m = run.metrics || {};
  if (metric !== 'total') return count(m[{ input: 'inputTokens', output: 'outputTokens', reasoning: 'reasoningTokens' }[metric]]);
  if (count(m.totalTokens) !== null) return m.totalTokens;
  const input = count(m.inputTokens), output = count(m.outputTokens);
  return input !== null && output !== null ? input + output : null;
}
export function plotData(runs, filters, metric) {
  const matching = runs.filter(run => matchesRun(run, filters));
  const points = matching.map(run => ({ run, tokens: tokenCount(run, metric), cost: count(run.metrics?.cost) }))
    .filter(point => point.tokens !== null && point.cost !== null);
  return { points, missing: matching.length - points.length };
}
