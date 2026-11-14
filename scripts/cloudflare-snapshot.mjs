import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const db = new DatabaseSync(resolve('data/oneshot.sqlite'), { readOnly: true });
db.exec('BEGIN');
const snapshot = {
  format: 1, snapshotId: crypto.randomUUID(), exportedAt: new Date().toISOString(),
  settings: JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value),
  prompts: db.prepare('SELECT * FROM prompts').all(), versions: db.prepare('SELECT * FROM versions').all(),
  runs: db.prepare('SELECT * FROM runs ORDER BY rowid').all(),
};
db.exec('COMMIT'); db.close();
const out = resolve(process.argv[2] || 'data/cloudflare-snapshot.json');
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, JSON.stringify(snapshot), { mode: 0o600 });
console.log(`Saved ${snapshot.prompts.length} prompts and ${snapshot.runs.length} runs to ${out}. No API key included.`);
