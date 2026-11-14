import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Runner } from '../server/runner.mjs';
import { createApp } from '../server/app.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const store = new Store(resolve(root, 'data/oneshot.sqlite'));
store.recover();
const runner = new Runner(store, { getKey: () => process.env.OPENROUTER_API_KEY });
const servers = [5173, 4310].map((port) => {
  const server = createApp({ store, runner, root, envPath: resolve(root, '.env') });
  server.listen(port, '127.0.0.1', () => console.log('Oneshot: http://127.0.0.1:' + port));
  return server;
});
runner.pump();
function stop() {
  runner.stop();
  servers.forEach((s) => s.close());
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 300);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
