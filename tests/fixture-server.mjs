// Isolated browser-QA workspace. All model responses are deterministic fixtures; no OpenRouter requests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/app.mjs';
const directory = mkdtempSync(resolve(tmpdir(), 'oneshot-browser-'));
const store = new Store(resolve(directory, 'data.sqlite'));
const models = Array.from({ length: 9 }, (_, i) => ({
  id: `${i < 5 ? 'fixture-a' : 'fixture-b'}/model-${i + 1}`,
  name: `Fixture model ${i + 1}`,
  context_length: 32000,
  pricing: { prompt: '0', completion: '0' },
  description: 'Deterministic browser test model. No real API calls.',
  ...(i === 0 ? { reasoning: { supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium', mandatory: true } } : {}),
}));
store.saveSettings({ selectedModels: models });
function output(model) {
  return `<!DOCTYPE html><html><head><style>body{margin:0;background:#f8f5ee;font:20px system-ui;padding:70px;color:#343a2d}small{font-size:13px;color:#8c9978;letter-spacing:2px}h1{font-size:58px;letter-spacing:-3px;max-width:800px}button{padding:18px 30px;border:0;border-radius:10px;background:#566946;color:white;font:18px system-ui}.cards{display:flex;gap:25px;margin-top:40px}.card{padding:35px;background:white;border:1px solid #e3e9d5;border-radius:15px;width:250px}.card strong{font-size:42px;display:block;margin-top:12px}</style></head><body><small>ISOLATED QA FIXTURE · ${model}</small><h1>A little space for your next big idea.</h1><p>This is a deterministic test implementation, not a model-generated benchmark result.</p><button id="counter" onclick="this.textContent='Count: '+ ++window.count">Count: 0</button><div class="cards"><div class="card">Completed<strong>24</strong></div><div class="card">In progress<strong>08</strong></div></div><script>document.body.dataset.instance=Date.now()+'-'+Math.random();window.count=0;try{parent.document.body.dataset.escaped='yes'}catch{document.body.dataset.isolated='yes'}</script></body></html>`;
}
const batch = store.enqueue(
  [store.prompts()[0].id],
  models.map((m) => m.id),
);
for (let i = 0; i < batch.ids.length; i++)
  store.updateRun(batch.ids[i], {
    status: 'completed',
    html: output(models[i].name),
    raw: output(models[i].name),
    metrics: { durationMs: 12345 + i * 1000, inputTokens: 100, outputTokens: 1000, reasoningTokens: i === 0 ? 200 : null, cost: 0 },
    finished_at: new Date().toISOString(),
  });
store.updateRun(batch.ids.at(-1), { status: 'failed', html: null, raw: 'Fixture provider failure', error: 'Fixture provider failure' });
const versioned = store.prompts()[0];
store.editPrompt(versioned.id, { title: versioned.title, category: 'Versioned fixture',
  content: 'Version 2: Add keyboard shortcuts and a compact layout.\nKeep all data local.',
  baseVersionId: versioned.version_id });
const secondBatch = store.enqueue([store.prompts()[0].id, store.prompts()[1].id],
  ['medium', 'high'].map(reasoningEffort => ({ modelId: models[0].id, reasoningEffort })));
for (const id of secondBatch.ids) {
  const run = store.run(id);
  store.updateRun(id, { status: 'completed', html: output(run.model_name), raw: output(run.model_name),
    metrics: { durationMs: 12000, cost: 0 }, finished_at: new Date().toISOString() });
}
const runner = new Runner(store, {
  getKey: () => 'fixture-only',
  fetchImpl: async (url, options) =>
    Response.json({
      choices: [
        { message: { content: output(JSON.parse(options.body).model) }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100, cost: 0 },
    }),
});
const app = createApp({
  store,
  runner,
  getKey: () => 'fixture-only',
  envPath: resolve(directory, '.env'),
  fetchImpl: async () => Response.json({ data: models }),
});
app.listen(4311, '127.0.0.1', () => console.log('Isolated QA: http://127.0.0.1:4311'));
process.on('SIGINT', () => {
  app.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
});
