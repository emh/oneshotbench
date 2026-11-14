import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { safeDocument, PREVIEW_CSP } from './format.mjs';
import { modelCatalog, variants, validateEfforts } from './reasoning.mjs';

import { bad, text, number, promptBody, ids, runIds, outputTokens } from './validation.mjs';
async function bodyOf(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) throw bad('Request too large', 413);
  }
  try {
    const value = JSON.parse(body || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected object');
    return value;
  } catch {
    throw bad('Expected a JSON object');
  }
}

export function createApp({
  store,
  runner,
  envPath = resolve('.env'),
  getKey = () => process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  root = process.cwd(),
}) {
  const loadCatalog = modelCatalog(fetchImpl);
  const json = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const host = req.headers.host?.split(':')[0];
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
        throw bad('This service is local-only.', 403);
      if (path.startsWith('/api')) {
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (req.headers['x-oneshot-client'] !== 'admin')
            throw bad('Missing admin request header.', 403);
          if (req.headers.origin) {
            const origin = new URL(req.headers.origin);
            if (
              !['localhost', '127.0.0.1'].includes(origin.hostname) ||
              !['5173', String(req.socket.localPort)].includes(origin.port) ||
              origin.protocol !== 'http:'
            )
              throw bad('Cross-origin requests are not allowed.', 403);
          }
          if (!req.headers['content-type']?.startsWith('application/json'))
            throw bad('Expected application/json.', 415);
        }
        if (req.method === 'GET' && path === '/api/state')
          return json(res, 200, {
            prompts: store.prompts(),
            runs: store.runs(),
            settings: store.settings(),
            keyConfigured: !!getKey(),
          });
        if (req.method === 'GET' && path === '/api/settings')
          return json(res, 200, { ...store.settings(), keyConfigured: !!getKey() });
        if (req.method === 'PATCH' && path === '/api/settings') {
          const body = await bodyOf(req),
            patch = {};
          for (const [name, min, max, int] of [
            ['minWidth', 320, 7680, true],
            ['minHeight', 240, 4320, true],
            ['columns', 1, 9, true],
            ['concurrency', 1, 8, true],
            ['temperature', 0, 2, false],
            ['timeoutSeconds', 15, 1800, true],
          ])
            if (name in body) patch[name] = number(body[name], min, max, name, int);
          if ('maxTokens' in body) patch.maxTokens = outputTokens(body.maxTokens);
          if ('systemPrompt' in body)
            patch.systemPrompt = text(body.systemPrompt, 'Output instructions', 20000);
          if ('selectedModels' in body) {
            if (!Array.isArray(body.selectedModels) || body.selectedModels.length > 100)
              throw bad('Select up to 100 models.');
            patch.selectedModels = body.selectedModels.map((model) => ({
              id: text(model.id, 'Model ID', 200),
              name: text(model.name, 'Model name', 200),
              context_length: typeof model.context_length === 'number' ? model.context_length : 0,
              pricing: {
                prompt: String(model.pricing?.prompt ?? '0'),
                completion: String(model.pricing?.completion ?? '0'),
              },
            }));
            if (new Set(patch.selectedModels.map((m) => m.id)).size !== patch.selectedModels.length)
              throw bad('Duplicate model selection.');
          }
          if ('apiKey' in body) {
            const key = text(body.apiKey, 'API key', 500);
            if (!/^sk-or-[\w-]+$/.test(key)) throw bad('Enter a valid OpenRouter key (sk-or-…).');
            const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
            const line = `OPENROUTER_API_KEY=${key}`;
            const updated = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=.*$/m.test(source)
              ? source.replace(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=.*$/m, line)
              : `${source.trimEnd()}\n${line}\n`;
            writeFileSync(`${envPath}.tmp`, updated, { mode: 0o600 });
            renameSync(`${envPath}.tmp`, envPath);
            process.env.OPENROUTER_API_KEY = key;
          }
          const settings = store.saveSettings(patch);
          runner.pump();
          return json(res, 200, { ...settings, keyConfigured: !!getKey() });
        }
        if (req.method === 'POST' && path === '/api/key/test') {
          if (!getKey()) throw bad('No API key configured.');
          const response = await fetchImpl('https://openrouter.ai/api/v1/key', {
            headers: { Authorization: `Bearer ${getKey()}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw bad(`OpenRouter rejected the key (${response.status}).`, 502);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && path === '/api/models')
          return json(res, 200, { models: await loadCatalog(url.searchParams.has('refresh')), fetchedAt: new Date().toISOString() });
        if (req.method === 'POST' && path === '/api/prompts')
          return json(res, 201, store.createPrompt(promptBody(await bodyOf(req))));
        const promptMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
        if (promptMatch && req.method === 'PATCH')
          return json(res, 200, store.editPrompt(promptMatch[1], promptBody(await bodyOf(req))));
        if (promptMatch && req.method === 'DELETE') {
          if (!store.prompt(promptMatch[1])) throw bad('Prompt not found', 404);
          store.archivePrompt(promptMatch[1], true);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/api/runs') {
          if (!getKey()) throw bad('Add an OpenRouter API key in Settings first.');
          const body = await bodyOf(req),
            promptIds = ids(body.promptIds),
            modelIds = variants(body.modelVariants ?? ids(body.modelIds));
          if (promptIds.length * modelIds.length > 200)
            throw bad('A batch can include at most 200 implementations.');
          await validateEfforts(modelIds, store.settings().selectedModels, loadCatalog);
          const overrides = {};
          if ('temperature' in body)
            overrides.temperature = number(body.temperature, 0, 2, 'Temperature');
          if ('maxTokens' in body)
            overrides.maxTokens = outputTokens(body.maxTokens);
          const result = store.enqueue(promptIds, modelIds, overrides, body.promptVersions);
          runner.pump();
          return json(res, 201, result);
        }
        if (req.method === 'POST' && path === '/api/runs/retry') {
          if (!getKey()) throw bad('Add an OpenRouter API key in Settings first.');
          const result = store.retryRuns(runIds((await bodyOf(req)).ids));
          runner.pump();
          return json(res, 201, result);
        }
        if (req.method === 'DELETE' && path === '/api/runs') {
          const selected = runIds((await bodyOf(req)).ids);
          for (const id of selected) runner.cancel(id);
          const deleted = store.deleteRuns(selected);
          runner.pump();
          return json(res, 200, { deleted });
        }
        const runMatch = path.match(/^\/api\/runs\/([^/]+)(?:\/(html|cancel|retry))?$/);
        if (runMatch) {
          const run = store.run(runMatch[1]);
          if (!run) throw bad('Run not found', 404);
          if (req.method === 'POST' && runMatch[2] === 'retry') {
            if (!getKey()) throw bad('Add an OpenRouter API key in Settings first.');
            const result = store.retryRun(run.id);
            runner.pump();
            return json(res, 201, result);
          }
          if (req.method === 'POST' && runMatch[2] === 'cancel') {
            if (!runner.cancel(run.id)) throw bad('This run has already finished.', 409);
            return json(res, 200, { ok: true });
          }
          if (req.method === 'GET' && runMatch[2] === 'html') {
            if (!run.html) throw bad('This run has no preview.', 404);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': `${PREVIEW_CSP}; sandbox allow-scripts`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            return res.end(safeDocument(run.html));
          }
          if (req.method === 'GET' && !runMatch[2]) return json(res, 200, run);
        }
        if (req.method === 'GET' && path === '/api/gallery') {
          const { minWidth, minHeight, columns } = store.settings();
          return json(res, 200, {
            mode: 'local',
            settings: { minWidth, minHeight, columns },
            runs: store.runs({ details: true, completed: true }).map(({ raw, ...run }) => run),
          });
        }
        throw bad('API endpoint not found', 404);
      }
      const gallery = path === '/gallery' || path.startsWith('/gallery/');
      if (path === '/gallery') {
        res.writeHead(302, { Location: '/gallery/' });
        return res.end();
      }
      const app = gallery ? 'gallery' : 'admin';
      const requested = gallery ? path.slice(8) : path;
      const assets = {
        '/': `${app}/index.html`,
        '/index.html': `${app}/index.html`,
        '/app/main.js': `${app}/main.js`,
        '/shared/dom.js': 'shared/dom.js',
        '/shared/styles.css': 'shared/styles.css',
      };
      if (!Object.hasOwn(assets, requested)) throw bad('File not found', 404);
      const file = resolve(root, 'apps', assets[requested]);
      const mime =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
        }[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(file));
    } catch (error) {
      const key = getKey();
      let message = error.message || 'Unexpected server error';
      if (key) message = message.split(key).join('[redacted]');
      json(res, error.status || 500, { error: message });
    }
  });
}
