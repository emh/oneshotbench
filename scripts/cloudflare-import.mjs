import { readFileSync } from 'node:fs';
const origin = process.env.ADMIN_ORIGIN;
const client = process.env.CF_ACCESS_CLIENT_ID, secret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!origin?.startsWith('https://') || !client || !secret)
  throw Error('Set ADMIN_ORIGIN and an Access service token in CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.');
const snapshot = JSON.parse(readFileSync(process.argv[2] || 'data/cloudflare-snapshot.json', 'utf8'));
if (snapshot.format !== 1) throw Error('Unsupported snapshot');
async function send(body) {
  const response = await fetch(new URL('/api/import', origin), {
    method: 'POST', redirect: 'error', headers: {
      'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin',
      'CF-Access-Client-Id': client, 'CF-Access-Client-Secret': secret,
    }, body: JSON.stringify({ ...body, snapshotId: snapshot.snapshotId }),
  });
  if (!response.ok) throw Error(`Import failed (${response.status}). Local snapshot is unchanged; re-run to resume.`);
  return response.json();
}
await send({ phase: 'start', settings: snapshot.settings, prompts: snapshot.prompts,
  versions: snapshot.versions, runCount: snapshot.runs.length });
for (let i = 0; i < snapshot.runs.length; i++) {
  await send({ phase: 'run', run: snapshot.runs[i] });
  console.log(`Imported ${i + 1}/${snapshot.runs.length}`);
}
await send({ phase: 'finish' });
console.log('Migration complete. Disable ALLOW_IMPORT and revoke the temporary Access service token.');
