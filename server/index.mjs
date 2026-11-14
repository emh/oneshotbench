import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Runner } from './runner.mjs';
import { createApp } from './app.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const store = new Store(resolve(root, 'data/oneshot.sqlite'));
store.recover();
const runner = new Runner(store, { getKey: () => process.env.OPENROUTER_API_KEY });
const server = createApp({ store, runner, root, envPath: resolve(root, '.env') });
const port = Number(process.env.PORT) || 4310;
server.listen(port, '127.0.0.1', () => {
  console.log(`Oneshot API + production app: http://127.0.0.1:${port}`);
  runner.pump();
});
function shutdown() {
  runner.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
