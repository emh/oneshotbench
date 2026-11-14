import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { WorkspaceService } from './workspace.mjs';
import { executeRun } from './generate.mjs';
import { route } from './router.mjs';
import adminHTML from '../apps/admin/index.html';
import galleryHTML from '../apps/gallery/index.html';
import adminJS from '../apps/admin/main.js.txt';
import galleryJS from '../apps/gallery/main.js.txt';
import domJS from '../apps/shared/dom.js.txt';
import galleryHelpers from '../apps/shared/gallery.js.txt';
import styles from '../apps/shared/styles.css';

const asset = (body, type) => ({ body, type });
const assets = {
  '/': asset(adminHTML, 'text/html; charset=utf-8'),
  '/index.html': asset(adminHTML, 'text/html; charset=utf-8'),
  '/app/main.js': asset(adminJS, 'text/javascript'),
  '/shared/dom.js': asset(domJS, 'text/javascript'),
  '/shared/styles.css': asset(styles, 'text/css'),
  '/gallery/': asset(galleryHTML, 'text/html; charset=utf-8'),
  '/gallery/index.html': asset(galleryHTML, 'text/html; charset=utf-8'),
  '/gallery/app/main.js': asset(galleryJS, 'text/javascript'),
  '/gallery/shared/dom.js': asset(domJS, 'text/javascript'),
  '/gallery/shared/gallery.js': asset(galleryHelpers, 'text/javascript'),
  '/gallery/shared/styles.css': asset(styles, 'text/css'),
};
export default { fetch: (request, env) => route(request, env, assets) };
export class Workspace extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.service = new WorkspaceService(ctx, env); }
  fetch(request) { return this.service.fetch(request); }
  alarm() { return this.service.alarm(); }
}
export class BenchmarkRun extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do('one-shot-generation', {
      retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes',
    }, () => executeRun(this.env, event.payload.id));
  }
}
