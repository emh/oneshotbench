import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const config = JSON.parse(readFileSync(process.argv[2] || 'cloudflare/config.json', 'utf8'));
const origin = new URL(config.publicApiOrigin).origin;
if (!origin.startsWith('https://')) throw Error('The public API must use HTTPS.');
const out = resolve('exports/pages');
mkdirSync(resolve(out, 'app'), { recursive: true });
cpSync('apps/gallery/main.js', resolve(out, 'app/main.js'));
cpSync('apps/shared', resolve(out, 'shared'), { recursive: true });
writeFileSync(resolve(out, 'index.html'), readFileSync('apps/gallery/index.html', 'utf8')
  .replace('<head>', '<head><meta name="oneshot-api" content="' + origin + '">'));
writeFileSync(resolve(out, '.nojekyll'), '');
console.log(`Copied static gallery to ${out}. Publish this directory with GitHub Pages. No database snapshot or credentials included.`);
