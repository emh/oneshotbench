import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { StoreCore } from './store-core.mjs';
export { defaults } from './store-core.mjs';

export class Store extends StoreCore {
  constructor(path, options) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode=WAL');
    super(db, options);
  }
}
