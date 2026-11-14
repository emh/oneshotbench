import { bad, text, number, promptBody, ids, runIds } from '../server/validation.mjs';
import { safeDocument, PREVIEW_CSP } from '../server/format.mjs';
import { variants, validateEfforts } from '../server/reasoning.mjs';

export const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function bodyOf(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw bad('Request too large', 413); }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(await new Blob(chunks).text());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw bad('Expected a JSON object'); }
}

export async function api(request, workspace) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const store = workspace.store;
  const key = await workspace.key();
  if (method === 'GET' && path === '/api/state') return json({
    prompts: store.prompts(), runs: store.runs(), settings: store.settings(),
    keyConfigured: !!key, environment: 'CLOUDFLARE', galleryUrl: workspace.env.GALLERY_URL || '/gallery/',
    importEnabled: workspace.env.ALLOW_IMPORT === 'true',
  });
  if (method === 'GET' && path === '/api/settings') return json({ ...store.settings(), keyConfigured: !!key });
  if (method === 'PATCH' && path === '/api/settings') {
    const body = await bodyOf(request), patch = {};
    for (const [name, min, max, int] of [
      ['minWidth', 320, 7680, true], ['minHeight', 240, 4320, true], ['columns', 1, 9, true],
      ['concurrency', 1, 8, true], ['temperature', 0, 2, false], ['maxTokens', 256, 128000, true],
      ['timeoutSeconds', 15, 1740, true],
    ]) if (name in body) patch[name] = number(body[name], min, max, name, int);
    if ('systemPrompt' in body) patch.systemPrompt = text(body.systemPrompt, 'Output instructions', 20000);
    if ('selectedModels' in body) {
      if (!Array.isArray(body.selectedModels) || body.selectedModels.length > 100) throw bad('Select up to 100 models.');
      patch.selectedModels = body.selectedModels.map(m => ({
        id: text(m.id, 'Model ID', 200), name: text(m.name, 'Model name', 200),
        context_length: typeof m.context_length === 'number' ? m.context_length : 0,
        pricing: { prompt: String(m.pricing?.prompt ?? '0'), completion: String(m.pricing?.completion ?? '0') },
      }));
      if (new Set(patch.selectedModels.map(m => m.id)).size !== patch.selectedModels.length) throw bad('Duplicate model selection.');
    }
    if ('apiKey' in body) {
      const value = text(body.apiKey, 'API key', 500);
      if (!/^sk-or-[\w-]+$/.test(value)) throw bad('Enter a valid OpenRouter key (sk-or-…).');
      await workspace.saveKey(value);
    }
    const settings = store.saveSettings(patch);
    await workspace.wake();
    return json({ ...settings, keyConfigured: !!await workspace.key() });
  }
  if (method === 'POST' && path === '/api/key/test') {
    if (!key) throw bad('No API key configured.');
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw bad(`OpenRouter rejected the key (${response.status}).`, 502);
    return json({ ok: true });
  }
  if (method === 'GET' && path === '/api/models') {
    return json({ models: await workspace.models(url.searchParams.has('refresh')), fetchedAt: new Date().toISOString() });
  }
  if (method === 'POST' && path === '/api/prompts') return json(store.createPrompt(promptBody(await bodyOf(request))), 201);
  const prompt = path.match(/^\/api\/prompts\/([^/]+)$/);
  if (prompt && method === 'PATCH') return json(store.editPrompt(prompt[1], promptBody(await bodyOf(request))));
  if (prompt && method === 'DELETE') {
    if (!store.prompt(prompt[1])) throw bad('Prompt not found', 404);
    store.archivePrompt(prompt[1], true);
    return json({ ok: true });
  }
  if (method === 'POST' && path === '/api/runs') {
    if (!key) throw bad('Add an OpenRouter API key in Settings first.');
    const body = await bodyOf(request), promptIds = ids(body.promptIds), modelIds = variants(body.modelVariants ?? ids(body.modelIds));
    if (promptIds.length * modelIds.length > 200) throw bad('A batch can include at most 200 implementations.');
    await validateEfforts(modelIds, store.settings().selectedModels, workspace.models);
    const overrides = {};
    if ('temperature' in body) overrides.temperature = number(body.temperature, 0, 2, 'Temperature');
    if ('maxTokens' in body) overrides.maxTokens = number(body.maxTokens, 256, 128000, 'Output tokens', true);
    const result = store.enqueue(promptIds, modelIds, overrides, body.promptVersions);
    await workspace.wake();
    return json(result, 201);
  }
  if (method === 'DELETE' && path === '/api/runs')
    return json(await workspace.deleteRuns(runIds((await bodyOf(request)).ids)));
  const run = path.match(/^\/api\/runs\/([^/]+)(?:\/(html|cancel|retry))?$/);
  if (run) {
    const metadata = store.run(run[1]);
    if (!metadata) throw bad('Run not found', 404);
    if (method === 'POST' && run[2] === 'retry') {
      if (!key) throw bad('Add an OpenRouter API key in Settings first.');
      // Persist a wake before enqueueing so an interrupted response cannot strand the job.
      await workspace.wake();
      return json(store.retryRun(metadata.id), 201);
    }
    if (method === 'POST' && run[2] === 'cancel') { await workspace.cancel(metadata); return json({ ok: true }); }
    if (method === 'GET') {
      const result = await workspace.result(metadata);
      if (!run[2]) return json(result);
      if (run[2] === 'html') {
        if (!result.html) throw bad('This run has no preview.', 404);
        return new Response(safeDocument(result.html), { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': `${PREVIEW_CSP}; sandbox allow-scripts`,
        } });
      }
    }
  }
  if (method === 'GET' && path === '/api/gallery') {
    const { minWidth, minHeight, columns } = store.settings();
    const runs = [];
    for (const metadata of store.runs({ details: true, completed: true })) {
      const { raw, ...run } = await workspace.result(metadata);
      runs.push(run);
    }
    return json({ mode: 'cloud', adminUrl: workspace.env.ADMIN_ORIGIN + '/', settings: { minWidth, minHeight, columns }, runs });
  }
  throw bad('API endpoint not found', 404);
}
