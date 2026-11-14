import { bad } from './validation.mjs';

export const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function catalogModel(model) {
  const supported = model.reasoning?.supported_efforts;
  const efforts = supported === null ? effortLevels : Array.isArray(supported) ? supported : [];
  return {
    id: model.id, name: model.name, context_length: model.context_length,
    pricing: model.pricing, description: model.description,
    reasoningEfforts: effortLevels.filter(e => efforts.includes(e) && !(e === 'none' && model.reasoning?.mandatory)),
    defaultReasoningEffort: model.reasoning?.default_effort || null,
  };
}
export function modelCatalog(fetchImpl = fetch) {
  let cache, fetchedAt = 0;
  return async (force = false) => {
    if (!cache || force || Date.now() - fetchedAt > 3600000) {
      const response = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw bad(`Model catalog unavailable (${response.status}).`, 502);
      const data = await response.json();
      cache = (data.data || []).filter(m => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text')).map(catalogModel);
      fetchedAt = Date.now();
    }
    return cache;
  };
}
export function variants(choices) {
  if (!Array.isArray(choices) || !choices.length || choices.length > 800)
    throw bad('Select at least one model.');
  const result = choices.map(choice => {
    const value = typeof choice === 'string' ? { modelId: choice } : choice;
    if (!value || typeof value.modelId !== 'string' || !value.modelId || value.modelId.length > 200 ||
      (value.reasoningEffort !== undefined && !effortLevels.includes(value.reasoningEffort)))
      throw bad('Invalid model or reasoning effort.');
    return { modelId: value.modelId, ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort } : {}) };
  });
  return [...new Map(result.map(v => [JSON.stringify(v), v])).values()];
}
export async function validateEfforts(choices, enabledModels, loadCatalog) {
  if (choices.some(v => !enabledModels.some(m => m.id === v.modelId)))
    throw bad('Choose enabled models.');
  if (!choices.some(v => v.reasoningEffort !== undefined)) return;
  const catalog = await loadCatalog();
  for (const v of choices) {
    if (v.reasoningEffort === undefined) continue;
    if (!catalog.find(m => m.id === v.modelId)?.reasoningEfforts.includes(v.reasoningEffort))
      throw bad(`Reasoning effort ${v.reasoningEffort} is not supported for ${v.modelId}. Refresh the model list.`);
  }
}
