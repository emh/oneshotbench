export const PREVIEW_SANDBOX = 'allow-scripts allow-forms';
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Keep the frame's opaque origin. Exposing the gallery's native origin would give
// generated scripts access to the parent app. Only this run's storage is bridged.
export const STORAGE_PREFIX = 'oneshot-preview:v1:';
export const STORAGE_LIMIT = 1_000_000;
const frames = new WeakMap();
let listening = false;
const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).every(item => typeof item === 'string');
function readStorage(key) {
  const value = JSON.parse(localStorage.getItem(key) || '{}');
  return validSnapshot(value) ? value : {};
}
export function storageChange(snapshot, message) {
  const next = Object.assign(Object.create(null), snapshot);
  if (message.op === 'clear') return Object.create(null);
  if (typeof message.key !== 'string') throw Error('Invalid storage key');
  if (message.op === 'remove') delete next[message.key];
  else if (message.op === 'set' && typeof message.value === 'string') next[message.key] = message.value;
  else throw Error('Invalid storage operation');
  if (JSON.stringify(next).length > STORAGE_LIMIT) throw Error('Preview storage quota exceeded');
  return next;
}
export function previewStorage(frame, runId, onError) {
  if (typeof runId !== 'string' || !runId) throw Error('A run ID is required for preview storage');
  const key = STORAGE_PREFIX + runId;
  let snapshot = {}, available = true;
  try { snapshot = readStorage(key); } catch { available = false; }
  frames.set(frame, { key, onError });
  if (!listening) {
    listening = true;
    window.addEventListener('message', event => {
      if (event.origin !== 'null' || event.data?.type !== 'oneshot:storage') return;
      const frame = [...document.querySelectorAll('iframe')].find(item => item.contentWindow === event.source);
      const entry = frames.get(frame);
      if (!entry) return;
      try {
        const next = storageChange(readStorage(entry.key), event.data);
        localStorage.setItem(entry.key, JSON.stringify(next));
        for (const other of document.querySelectorAll('iframe')) {
          if (other !== frame && frames.get(other)?.key === entry.key)
            other.contentWindow.postMessage({ type: 'oneshot:storage-sync', snapshot: next }, '*');
        }
      } catch {
        entry.onError?.('This run’s changes could not be saved in browser storage.');
      }
    });
  }
  return { snapshot, available, limit: STORAGE_LIMIT };
}

// Runs before any generated script. The Storage-compatible facade is synchronous
// inside the frame; persistence in the parent is asynchronous via postMessage.
function installStorage({ snapshot, available, limit }) {
  let state = Object.assign(Object.create(null), snapshot);
  const change = (op, key, value) => {
    if (!available) throw new DOMException('Browser storage is unavailable', 'SecurityError');
    const next = op === 'clear' ? Object.create(null) : Object.assign(Object.create(null), state);
    if (op === 'set') next[key] = value;
    if (op === 'remove') delete next[key];
    if (JSON.stringify(next).length > limit) throw new DOMException('Preview storage quota exceeded', 'QuotaExceededError');
    state = next;
    parent.postMessage({ type: 'oneshot:storage', op, key, value }, '*');
  };
  const methods = {
    getItem: key => Object.hasOwn(state, String(key)) ? state[String(key)] : null,
    setItem: (key, value) => change('set', String(key), String(value)),
    removeItem: key => change('remove', String(key)),
    clear: () => change('clear'),
    key: index => Object.keys(state)[Number(index) >>> 0] ?? null,
  };
  const storage = new Proxy(Object.create(Storage.prototype), {
    get: (_, key) => key === 'length' ? Object.keys(state).length :
      Object.hasOwn(methods, key) ? methods[key] : state[key],
    set: (_, key, value) => { change('set', String(key), String(value)); return true; },
    deleteProperty: (_, key) => { change('remove', String(key)); return true; },
    ownKeys: () => Object.keys(state),
    getOwnPropertyDescriptor: (_, key) => Object.hasOwn(state, key) ?
      { configurable: true, enumerable: true, writable: true, value: state[key] } : undefined,
    has: (_, key) => key === 'length' || Object.hasOwn(methods, key) || Object.hasOwn(state, key),
  });
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: false });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'oneshot:storage-sync') return;
    state = Object.assign(Object.create(null), event.data.snapshot);
  });
}
export function previewDocument(html, storage) {
  const bootstrap = storage ? '<script>(' + installStorage.toString() + ')(' +
    JSON.stringify(storage).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ');</script>' : '';
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${bootstrap}\n${html.replace(/<!doctype[^>]*>/i, '')}`;
}
