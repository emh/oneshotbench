export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key !== 'value' && value != null && value !== false) {
      if (key in node && !key.startsWith('aria-')) node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity))
    if (child != null && child !== false)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  if ('value' in attrs) node.value = attrs.value;
  return node;
}
export const button = (label, action, kind = '', attrs = {}) =>
  h('button', { type: 'button', class: 'button ' + kind, onClick: action, ...attrs }, label);
export const link = (label, href, kind = '') => h('a', { href, class: 'button ' + kind }, label);
export const field = (label, control) =>
  h('label', { class: 'field' }, h('span', {}, label), control);
export const select = (label, values, value, action) =>
  h(
    'select',
    { 'aria-label': label, value, onChange: (e) => action(e.target.value) },
    values.map(([id, name]) => h('option', { value: id }, name)),
  );
export const input = (label, value, action, attrs = {}) =>
  h('input', { 'aria-label': label, value, onInput: (e) => action(e.target.value), ...attrs });
export const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
export const name = (s) =>
  s.replace(/^(OpenAI|Anthropic|Google|Meta|DeepSeek|Qwen|Mistral|xAI):\s*/i, '');
export const runModelName = run => name(run.model_name) +
  (run.config?.reasoningEffort !== undefined ? ' · ' + run.config.reasoningEffort : '');
export const money = (n) =>
  n == null ? '—' : n === 0 ? '$0.00' : '$' + n.toFixed(n < 0.01 ? 4 : 3);
export function tokenUsage(metrics = {}) {
  const parts = [['inputTokens', 'in'], ['outputTokens', 'out']]
    .filter(([key]) => metrics?.[key] != null)
    .map(([key, label]) => metrics[key].toLocaleString() + ' ' + label);
  if (!parts.length && metrics?.totalTokens != null) parts.push(metrics.totalTokens.toLocaleString() + ' total');
  if (metrics?.reasoningTokens != null) parts.push(metrics.reasoningTokens.toLocaleString() + ' reasoning');
  return parts.length ? parts.join(' / ') : '—';
}
export const tokens = metrics => h('span', { class: 'token-usage mono',
  title: 'Token usage: input / output / reasoning (included in output)' }, tokenUsage(metrics));
export const duration = (r) => {
  const n =
    r.metrics?.durationMs ??
    (r.finished_at && r.started_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null);
  return n == null ? '—' : n < 1000 ? n + ' ms' : (n / 1000).toFixed(1) + ' s';
};
export const date = (s) =>
  new Date(s).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function failure(r) {
  if (r.status !== 'failed') return '';
  if (/^OpenRouter 402\b/.test(r.error || ''))
    return (
      'Credit limit' +
      (r.error.match(/can only afford ([\d,]+)/i)?.[1]
        ? ' · ' + r.error.match(/can only afford ([\d,]+)/i)[1] + ' tokens affordable'
        : '')
    );
  if (r.finish_reason === 'length')
    return 'Output limit · ' + r.config.maxTokens.toLocaleString() + ' tokens';
  return r.error || 'Request failed';
}
export async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Oneshot-Client': 'admin' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
export function replace(target, content) {
  const focused = document.activeElement,
    key = focused?.getAttribute('aria-label');
  const selection =
    focused?.tagName === 'INPUT' && focused.type === 'text'
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  target.replaceChildren(content);
  if (key) {
    const next = [...target.querySelectorAll('[aria-label]')].find(
      (n) => n.getAttribute('aria-label') === key,
    );
    if (next) {
      next.focus({ preventScroll: true });
      if (selection) next.setSelectionRange(...selection);
    }
  }
}
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 4500);
}
export function modal(title, body, footer = []) {
  const dialog = h(
    'dialog',
    { 'aria-label': title },
    h(
      'header',
      { class: 'modal-header' },
      h('h2', {}, title),
      button('×', () => dialog.close(), 'icon', { 'aria-label': 'Close dialog' }),
    ),
    h('div', { class: 'modal-body' }, body),
    h('footer', { class: 'modal-footer' }, footer),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
export const empty = (text) => h('div', { class: 'empty' }, text);
export const errorBox = (text) => h('div', { class: 'error', role: 'alert' }, text);
export function preview(html, title, { thumbnail = false, width = 1200, height = 900 } = {}) {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const frame = h('iframe', {
    title,
    sandbox: 'allow-scripts',
    referrerPolicy: 'no-referrer',
    loading: 'lazy',
    srcdoc:
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="' +
      csp +
      '">' +
      html.replace(/<!doctype[^>]*>/i, ''),
  });
  const wrapper = h('div', { class: thumbnail ? 'thumbnail' : 'preview' }, frame);
  if (thumbnail) {
    frame.tabIndex = -1;
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';
    const observer = new ResizeObserver(() => {
      if (!wrapper.isConnected) {
        observer.disconnect();
        return;
      }
      const scale = wrapper.clientWidth / (parseFloat(frame.style.width) || width);
      frame.style.transform = 'scale(' + scale + ')';
      wrapper.style.height = (parseFloat(frame.style.height) || height) * scale + 'px';
    });
    observer.observe(wrapper);
    observer.observe(frame);
  }
  return wrapper;
}
