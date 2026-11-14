import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareToken } from './cloudflare-client.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export function deployment(config, first = false) {
  const modules = [
    ...readdirSync(resolve(root, 'cloudflare')).filter(f => f.endsWith('.mjs')).map(f => [`cloudflare/${f}`, `cloudflare/${f}`, 'application/javascript+module']),
    ...['store-core', 'format', 'validation', 'reasoning'].map(f => [`server/${f}.mjs`, `server/${f}.mjs`, 'application/javascript+module']),
    ...['admin', 'gallery'].flatMap(app => [
      [`apps/${app}/index.html`, `apps/${app}/index.html`, 'text/plain'],
      [`apps/${app}/main.js.txt`, `apps/${app}/main.js`, 'text/plain'],
    ]),
    ['apps/shared/dom.js.txt', 'apps/shared/dom.js', 'text/plain'],
    ['apps/shared/gallery.js.txt', 'apps/shared/gallery.js', 'text/plain'],
    ['apps/shared/styles.css', 'apps/shared/styles.css', 'text/plain'],
  ].map(([name, source, type]) => ({ name, type, source: readFileSync(resolve(root, source), 'utf8') }));
  const metadata = {
    main_module: 'cloudflare/worker.mjs', compatibility_date: '2026-11-13',
    keep_bindings: ['secret_text'],
    bindings: [
      { type: 'durable_object_namespace', name: 'WORKSPACE', class_name: 'Workspace' },
      { type: 'r2_bucket', name: 'OUTPUTS', bucket_name: config.bucketName },
      { type: 'workflow', name: 'RUNS', workflow_name: config.workflowName, class_name: 'BenchmarkRun' },
      ...Object.entries(config.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ],
    ...(first ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Workspace'] } } : {}),
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const module of modules) form.set(module.name, new Blob([module.source], { type: module.type }), module.name);
  return { metadata, modules, form };
}
async function main() {
  const config = JSON.parse(readFileSync(process.argv.find(a => a.endsWith('.json')) || 'cloudflare/config.json', 'utf8'));
  const apply = process.argv.includes('--apply');
  if (!apply) {
    const { modules } = deployment(config, true);
    console.log(JSON.stringify({ worker: config.workerName, bucket: config.bucketName, workflow: config.workflowName,
      admin: config.vars.ADMIN_ORIGIN, publicGallery: config.vars.PUBLIC_GALLERY,
      modules: modules.map(m => ({ name: m.name, bytes: Buffer.byteLength(m.source) })) }, null, 2));
    console.log('Dry run. --apply uploads these unchanged source modules; no bundler or build step.');
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) throw Error('Set accountId.');
  const token = await cloudflareToken();
  if (JSON.stringify(config).includes('YOUR') || config.vars.ADMIN_ORIGIN.includes('example.com')) throw Error('Replace example configuration before deploying.');
  for (const name of [config.workerName, config.bucketName, config.workflowName])
    if (!/^[a-z0-9-]{3,63}$/.test(name)) throw Error('Invalid Cloudflare resource name.');
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}`;
  async function call(path, method = 'GET', body, allowMissing = false) {
    const form = body instanceof FormData;
    const response = await fetch(base + path, { method, headers: {
      Authorization: `Bearer ${token}`,
      ...(!form && body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    if (allowMissing && response.status === 404) return null;
    const result = await response.json();
    if (!response.ok || !result.success) throw Error(`Cloudflare ${method} ${path} failed (${response.status}; codes ${(result.errors || []).map(e => e.code).join(',')}).`);
    return result.result;
  }
  if (!await call(`/r2/buckets/${config.bucketName}`, 'GET', undefined, true))
    await call('/r2/buckets', 'POST', { name: config.bucketName });
  const script = `/workers/scripts/${config.workerName}`;
  const existing = await call(script + '/settings', 'GET', undefined, true);
  if (!existing && (!process.env.KEY_ENCRYPTION_SECRET || process.env.KEY_ENCRYPTION_SECRET.length < 32))
    throw Error('Set KEY_ENCRYPTION_SECRET (32+ random characters) for the first deployment.');
  await call(script, 'PUT', deployment(config, !existing).form);
  await call(`/workflows/${config.workflowName}`, 'PUT', { script_name: config.workerName, class_name: 'BenchmarkRun' });
  for (const name of ['KEY_ENCRYPTION_SECRET', 'OPENROUTER_API_KEY']) {
    if (process.env[name]) await call(script + '/secrets', 'PUT', { name, text: process.env[name], type: 'secret_text' });
  }
  if (config.publicWorkerName) {
    if (!/^[a-z0-9-]{3,63}$/.test(config.publicWorkerName)) throw Error('Invalid public Worker name.');
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'public.mjs', compatibility_date: '2026-11-13', bindings: [
      { type: 'durable_object_namespace', name: 'WORKSPACE', class_name: 'Workspace', script_name: config.workerName },
      { type: 'plain_text', name: 'PUBLIC_GALLERY', text: config.vars.PUBLIC_GALLERY },
      { type: 'plain_text', name: 'GALLERY_ORIGIN', text: config.vars.GALLERY_ORIGIN },
    ] })], { type: 'application/json' }), 'metadata.json');
    form.set('public.mjs', new Blob([readFileSync(resolve(root, 'cloudflare/public.mjs'))], { type: 'application/javascript+module' }), 'public.mjs');
    await call(`/workers/scripts/${config.publicWorkerName}`, 'PUT', form);
    await call(`/workers/scripts/${config.publicWorkerName}/subdomain`, 'POST', { enabled: true, previews_enabled: false });
  }
  await call(script + '/subdomain', 'POST', { enabled: true, previews_enabled: false });
  console.log('Worker, SQLite namespace, private R2 bucket, and Workflow uploaded. Configure custom domains and Access before use.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
