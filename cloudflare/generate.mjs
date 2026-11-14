import { extractHtml } from '../server/format.mjs';

export async function generate(run, key, fetchImpl = fetch) {
  const start = Date.now();
  const result = { status: 'failed', html: null, raw: null, metrics: null };
  try {
    if (!key) throw Error('Configure an OpenRouter API key in Settings before running.');
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(run.config.timeoutSeconds, 1740) * 1000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Oneshot Bench' },
      body: JSON.stringify({ model: run.model_id, messages: [
        { role: 'system', content: run.config.systemPrompt }, { role: 'user', content: run.prompt_content },
      ], temperature: run.config.temperature, max_tokens: run.config.maxTokens,
      stream: false, provider: { allow_fallbacks: false } }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw Error(`OpenRouter ${response.status}: ${data.error?.message || response.statusText}`);
    const choice = data.choices?.[0];
    result.raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    result.metrics = { durationMs: Date.now() - start, inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null, totalTokens: data.usage?.total_tokens ?? null,
      cost: data.usage?.cost ?? null };
    Object.assign(result, { provider: data.provider ?? null, response_id: data.id ?? null,
      finish_reason: choice?.finish_reason ?? null, resolved_model: data.model ?? null });
    if (choice?.finish_reason === 'length') throw Error('Output token limit reached. The response was truncated; increase the output token limit and run again.');
    result.html = extractHtml(result.raw);
    result.status = 'completed';
  } catch (error) {
    result.error = String(error.message || error);
    if (key) result.error = result.error.split(key).join('[redacted]');
  }
  result.finished_at = new Date().toISOString();
  return result;
}

// All communication here is through a private Durable Object binding, never a public route.
export async function internal(stub, path, body) {
  const response = await stub.fetch(new Request('https://workspace/internal/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  if (!response.ok) throw Error('Workspace operation failed (' + response.status + ')');
  return response.json();
}
export async function executeRun(env, id, fetchImpl = fetch) {
  const stub = env.WORKSPACE.getByName('main');
  const key = `runs/${id}.json`;
  const saved = await env.OUTPUTS.get(key);
  if (saved) { await internal(stub, 'finish', { id }); return; }
  const claim = await internal(stub, 'claim', { id });
  if (!claim.run) return; // A persistent claim prevents replay of the billable call.
  const result = await generate(claim.run, claim.key, fetchImpl);
  await env.OUTPUTS.put(key, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
  await internal(stub, 'finish', { id });
}
