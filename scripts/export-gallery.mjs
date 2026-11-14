import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
const source = fileURLToPath(new URL('../apps', import.meta.url));
const out = resolve('exports/gallery');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'app'), { recursive: true });
cpSync(resolve(source, 'gallery/main.js'), resolve(out, 'app/main.js'));
cpSync(resolve(source, 'shared'), resolve(out, 'shared'), { recursive: true });
const index = resolve(out, 'index.html');
writeFileSync(
  index,
  readFileSync(resolve(source, 'gallery/index.html'), 'utf8').replace(
    '<head>',
    '<head><meta name="oneshot-export" content="static">',
  ),
);
const store = new Store(resolve('data/oneshot.sqlite'), { seed: false });
const { minWidth, minHeight, columns } = store.settings();
const runs = store.runs({ details: true, completed: true }).map(({ raw, ...run }) => run);
writeFileSync(
  resolve(out, 'data.json'),
  JSON.stringify({
    mode: 'static',
    ...store.galleryIndex(),
    exportedAt: new Date().toISOString(),
    settings: { minWidth, minHeight, columns },
    runs,
  }),
);
store.close();
console.log(
  `Exported ${runs.length} completed implementations to ${out}. Contains prompts, outputs, and run metadata; no API key or admin API.`,
);
