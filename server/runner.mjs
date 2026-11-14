import { extractHtml } from './format.mjs';
export class Runner {
  constructor(store, { getKey, fetchImpl = fetch, baseUrl = 'https://openrouter.ai/api/v1' } = {}) {
    this.store = store;
    this.getKey = getKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.active = new Map();
    this.stopped = false;
  }
  pump() {
    if (this.stopped) return;
    const waiting = this.store
      .runs()
      .filter((r) => r.status === 'queued')
      .reverse();
    while (waiting.length && this.active.size < this.store.settings().concurrency) {
      const run = this.store.run(waiting.shift().id),
        controller = new AbortController();
      this.active.set(run.id, controller);
      this.execute(run, controller).finally(() => {
        this.active.delete(run.id);
        this.pump();
      });
    }
  }
  async execute(run, controller) {
    const start = Date.now();
    const key = this.getKey();
    this.store.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });
    const timeout = setTimeout(
      () => controller.abort(new Error('The request exceeded its timeout.')),
      run.config.timeoutSeconds * 1000,
    );
    try {
      if (!key) throw new Error('Configure an OpenRouter API key in Settings before running.');
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'Oneshot Bench',
        },
        body: JSON.stringify({
          model: run.model_id,
          messages: [
            { role: 'system', content: run.config.systemPrompt },
            { role: 'user', content: run.prompt_content },
          ],
          temperature: run.config.temperature,
          max_tokens: run.config.maxTokens,
          stream: false,
          provider: { allow_fallbacks: false },
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error)
        throw new Error(
          `OpenRouter ${response.status}: ${data.error?.message || response.statusText}`,
        );
      const choice = data.choices?.[0];
      const raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      const metrics = {
        durationMs: Date.now() - start,
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
        totalTokens: data.usage?.total_tokens ?? null,
        cost: data.usage?.cost ?? null,
      };
      if (this.store.run(run.id)?.status !== 'running') return;
      this.store.updateRun(run.id, {
        raw,
        metrics,
        provider: data.provider ?? null,
        response_id: data.id ?? null,
        finish_reason: choice?.finish_reason ?? null,
        resolved_model: data.model ?? null,
      });
      if (choice?.finish_reason === 'length')
        throw new Error(
          'Output token limit reached. The response was truncated; increase the output token limit and run again.',
        );
      const html = extractHtml(raw);
      this.store.updateRun(run.id, {
        status: 'completed',
        html,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      if (this.store.run(run.id)?.status === 'running') {
        let message = controller.signal.aborted
          ? controller.signal.reason?.message || 'Request aborted'
          : error.message;
        if (key) message = message.split(key).join('[redacted]');
        this.store.updateRun(run.id, {
          status: 'failed',
          error: message,
          finished_at: new Date().toISOString(),
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  cancel(id) {
    const run = this.store.run(id);
    if (!run || !['queued', 'running'].includes(run.status)) return false;
    this.store.updateRun(id, {
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      error:
        run.status === 'running'
          ? 'Request cancelled. The provider may still charge for work already performed.'
          : null,
    });
    this.active.get(id)?.abort();
    return true;
  }
  stop() {
    this.stopped = true;
    for (const [id, controller] of this.active) {
      this.store.updateRun(id, {
        status: 'interrupted',
        finished_at: new Date().toISOString(),
        error: 'Server stopped. This request was not retried.',
      });
      controller.abort();
    }
  }
}
