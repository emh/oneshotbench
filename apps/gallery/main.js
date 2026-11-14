import {
  h,
  button,
  select,
  badge,
  name,
  runModelName,
  reasoningFilterOptions,
  money,
  tokens,
  tokenUsage,
  duration,
  modal,
  empty,
  errorBox,
  preview,
} from '../shared/dom.js';
import { readGalleryURL, galleryURL, matchesRun, plotData, plotAxes, hasGalleryFilters, clearGalleryFilters } from '../shared/gallery.js';
const root = document.getElementById('root');
let data,
  selected = new Set(),
  compare = [],
  columns = null,
  prompt = '',
  model = '',
  effort = '', version = '', batch = '', status = '', view = 'gallery', metric = 'total', axes = 'cost-tokens', hiddenModels = [];
let gallerySynced = false;
let previewEndpoint = '';
const htmlRequests = new Map();
let promptTrigger, promptCloseTimer;
const promptPopup = h('div', { id: 'prompt-popup', class: 'prompt-popup', role: 'tooltip', hidden: true,
  onPointerenter: () => clearTimeout(promptCloseTimer),
  onPointerleave: () => schedulePromptClose(),
});
document.body.append(promptPopup);
let plotTrigger, plotCloseTimer;
const plotPopup = h('div', { id: 'plot-popup', class: 'plot-popup', role: 'tooltip', hidden: true,
  onPointerenter: () => clearTimeout(plotCloseTimer),
  onPointerleave: () => schedulePlotClose(),
});
document.body.append(plotPopup);
function closePlot() {
  clearTimeout(plotCloseTimer);
  plotTrigger?.removeAttribute('aria-describedby');
  plotTrigger?.querySelector('.plot-point')?.classList.remove('inspected');
  plotTrigger = null;
  plotPopup.hidden = true;
}
function schedulePlotClose() {
  clearTimeout(plotCloseTimer);
  plotCloseTimer = setTimeout(closePlot, 180);
}
function positionPlot() {
  if (!plotTrigger || plotPopup.hidden) return;
  const anchor = plotTrigger.getBoundingClientRect(), box = plotPopup.getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > window.innerHeight) { closePlot(); return; }
  const left = Math.max(12, Math.min(anchor.right + 12, window.innerWidth - box.width - 12));
  const top = anchor.bottom + 8 + box.height <= window.innerHeight - 12
    ? anchor.bottom + 8 : Math.max(12, anchor.top - box.height - 8);
  Object.assign(plotPopup.style, { left: left + 'px', top: top + 'px' });
}
function closePrompt() {
  clearTimeout(promptCloseTimer);
  promptTrigger?.removeAttribute('aria-describedby');
  promptTrigger = null;
  promptPopup.hidden = true;
}
function schedulePromptClose() {
  clearTimeout(promptCloseTimer);
  promptCloseTimer = setTimeout(closePrompt, 180);
}
function promptVersions(runs) {
  return [...new Map(runs.map(r => [r.version_id || r.prompt_id + ':' + r.version, r])).values()];
}
function promptLabel(label, runs) {
  const trigger = h('button', { type: 'button', class: 'prompt-label',
    onPointerenter: event => { if (event.pointerType !== 'touch') show(); },
    onPointerleave: schedulePromptClose,
    onFocus: () => show(), onBlur: schedulePromptClose, onClick: () => show(),
  }, label);
  function show() {
    closePrompt();
    promptTrigger = trigger;
    trigger.setAttribute('aria-describedby', promptPopup.id);
    promptPopup.replaceChildren(...promptVersions(runs).map(run => h('section', {},
      h('h3', {}, run.prompt_title + ' · v' + run.version),
      h('pre', {}, run.prompt_content))));
    promptPopup.hidden = false;
    promptPopup.scrollTop = 0;
    const anchor = trigger.getBoundingClientRect(), box = promptPopup.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12));
    const top = anchor.bottom + 8 + box.height <= window.innerHeight - 12
      ? anchor.bottom + 8 : Math.max(12, anchor.top - box.height - 8);
    Object.assign(promptPopup.style, { left: left + 'px', top: top + 'px' });
  }
  return trigger;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closePrompt(); closePlot(); } });
document.addEventListener('pointerdown', event => {
  if (!promptPopup.contains(event.target) && !promptTrigger?.contains(event.target)) closePrompt();
  if (!plotPopup.contains(event.target) && !plotTrigger?.contains(event.target)) closePlot();
});
window.addEventListener('resize', () => { closePrompt(); closePlot(); });
document.addEventListener('scroll', event => {
  if (!promptPopup.contains(event.target)) closePrompt();
  if (!plotPopup.contains(event.target)) positionPlot();
}, true);
function routeState() { return { compare, columns, prompt, model, effort, version, batch, status, view, metric, axes, hiddenModels }; }
function readURL() {
  ({ compare, columns, prompt, model, effort, version, batch, status, view, metric, axes, hiddenModels } = readGalleryURL(location.search));
}
function urlFor(patch = {}) { return galleryURL(location.href, { ...routeState(), ...patch }).href; }
function runURL(id) { return galleryURL(location.href, { compare: [id] }).href; }
function navigate(url) {
  history.pushState({}, '', url);
  readURL();
  render();
}
function pageLink(label, href, className = '') {
  return h('a', { href, class: className, onClick: event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(href);
  } }, label);
}
function changeFilter(key, value) {
  navigate(urlFor({ [key]: value, ...(key === 'prompt' ? { version: '' } : {}) }));
}
function clearFilters() { navigate(galleryURL(location.href, clearGalleryFilters(routeState())).href); }
async function ensureHTML(run) {
  if (typeof run.html === 'string') return run.html;
  if (!data.lazyPreviews) throw Error('Preview unavailable');
  if (!htmlRequests.has(run.id)) htmlRequests.set(run.id, (async () => {
    const response = await fetch(previewEndpoint + '?run=' + encodeURIComponent(run.id));
    if (!response.ok) throw Error('Preview unavailable');
    const result = await response.json();
    if (result.id !== run.id || typeof result.html !== 'string') throw Error('Preview unavailable');
    run.html = result.html;
    return run.html;
  })().finally(() => htmlRequests.delete(run.id)));
  return htmlRequests.get(run.id);
}
function open(ids) { navigate(urlFor({ compare: ids })); }
function navigation() {
  return h('header', { class: 'gallery-header' },
    pageLink('⌘ ONESHOT', galleryURL(location.href, {}).href, 'brand'),
    h('nav', { class: 'gallery-nav', 'aria-label': 'Gallery navigation' },
      [['gallery', 'Results'], ['prompts', 'Prompts'], ['scatter', 'Scatterplot']].map(([id, label]) =>
        pageLink(label, urlFor({ view: id, compare: [], ...(id === 'gallery' ? { status: '' } : {}) }), view === id ? 'active' : ''))));
}
window.addEventListener('popstate', () => {
  readURL();
  render();
});
async function load() {
  try {
    const exported = document.querySelector('meta[name="oneshot-export"]');
    const endpoint = document.querySelector('meta[name="oneshot-api"]')?.content || '';
    previewEndpoint = endpoint + '/api/gallery';
    const response = await fetch(exported ? new URL('data.json', location.href) : previewEndpoint + '?metadata=1');
    if (!response.ok) throw Error('Gallery unavailable');
    data = await response.json();
    data.runs = data.runs.map(withPrompt);
    gallerySynced = false;
    render();
  } catch (e) {
    (galleryView?.isConnected ? galleryControls.notice : root).replaceChildren(errorBox(e.message), button('Retry', load));
  }
}
// Keep cards mounted: removing or reparenting an iframe resets its document.
let galleryView, comparisonHost, galleryControls, pageHost;
const cards = new Map(), batches = new Map();
const previewQueue = new Set();
let activePreviews = 0;
const previewObserver = new IntersectionObserver(entries => {
  for (const item of entries) {
    const entry = cards.get(item.target.dataset.runId);
    if (!entry) continue;
    entry.near = item.isIntersecting;
    if (entry.near && entry.previewState === 'idle') previewQueue.add(entry);
  }
  pumpPreviews();
}, { rootMargin: '250px 0px' });
function previewEligible(entry) {
  if (!entry.near || !entry.card.isConnected || entry.card.hidden || galleryView.hidden) return false;
  const rect = entry.card.getBoundingClientRect();
  return rect.bottom >= -250 && rect.top <= window.innerHeight + 250;
}
function pumpPreviews() {
  for (const entry of previewQueue) {
    if (activePreviews >= 3) break;
    previewQueue.delete(entry);
    if (entry.previewState !== 'idle' || !previewEligible(entry)) continue;
    activePreviews++;
    entry.previewState = 'loading';
    entry.previewButton.classList.add('loading');
    ensureHTML(entry.run).then(html => {
      if (!previewEligible(entry)) { entry.previewState = 'idle'; return; }
      entry.previewButton.replaceChildren(preview(html, entry.run.prompt_title + ' · ' + runModelName(entry.run) + ' · ' + entry.run.id,
        { thumbnail: true, width: data.settings.minWidth, height: data.settings.minHeight }));
      entry.previewState = 'loaded';
      previewObserver.unobserve(entry.card);
    }).catch(() => {
      entry.previewState = 'error';
      entry.previewButton.replaceChildren(h('span', { class: 'preview-message' }, 'Preview unavailable · Open to retry'));
    }).finally(() => {
      activePreviews--;
      entry.previewButton.classList.remove('loading');
      pumpPreviews();
    });
  }
}
function mountGallery() {
  const resultCount = badge(''), batchList = h('div', { class: 'gallery-batches' });
  const noResults = empty('No results');
  const selectionCount = h('span', {});
  const compareButton = button('Compare →', () => open([...selected]), 'primary');
  const selectionBar = h('div', { class: 'selection', hidden: true }, selectionCount,
    button('Clear', () => { selected.clear(); updateGallery(); }), compareButton);
  const promptFilter = select('Filter gallery by prompt', [], prompt, v => changeFilter('prompt', v));
  const modelFilter = select('Filter gallery by model', [], model, v => changeFilter('model', v));
  const effortFilter = select('Filter gallery by reasoning level', reasoningFilterOptions, effort, v => changeFilter('effort', v));
  const versionFilter = select('Filter gallery by prompt version', [], version, v => changeFilter('version', v));
  const batchFilter = select('Filter gallery by batch', [], batch, v => changeFilter('batch', v));
  const clearButton = button('Clear all', clearFilters);
  const notice = h('div', { role: 'status' });
  galleryView = h('div', { class: 'gallery-app' },
    navigation(),
    h('main', { class: 'gallery-content' },
      h('div', { class: 'toolbar standalone gallery-filters' }, promptFilter, modelFilter, effortFilter, versionFilter, batchFilter, clearButton, resultCount),
      notice, batchList, noResults, selectionBar));
  comparisonHost = h('div', { hidden: true });
  galleryControls = { resultCount, batchList, noResults, selectionCount, selectionBar,
    compareButton, promptFilter, modelFilter, effortFilter, versionFilter, batchFilter, clearButton, notice };
  pageHost = h('div', { hidden: true });
  root.replaceChildren(galleryView, comparisonHost, pageHost);
}
function syncGallery() {
  if (!galleryView?.isConnected) mountGallery();
  const ids = new Set(data.runs.map(r => r.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  for (const [id, entry] of cards) if (!ids.has(id)) {
    previewObserver.unobserve(entry.card); previewQueue.delete(entry); entry.card.remove(); cards.delete(id);
  }
  const groups = new Map();
  for (const run of data.runs) {
    const id = run.batch_id || run.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  for (const [id, entry] of batches) if (!groups.has(id)) { entry.section.remove(); batches.delete(id); }
  for (const [id, runs] of groups) {
    let batch = batches.get(id);
    if (!batch) {
      const heading = h('header', { class: 'batch-heading' }), grid = h('div', { class: 'gallery-grid' });
      const section = h('section', { class: 'gallery-batch', 'data-batch-id': id }, heading, grid);
      batch = { section, heading, grid };
      batches.set(id, batch);
      galleryControls.batchList.append(section);
    }
    batch.runs = runs;
    batch.createdAt = runs.reduce((first, r) => r.created_at < first ? r.created_at : first, runs[0].created_at);
    batch.summaryKey = null;
    batch.titleLink = h('a', { href: urlFor({ batch: id }), onClick: event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); changeFilter('batch', id);
    } }, h('time', { dateTime: batch.createdAt }, new Date(batch.createdAt).toLocaleString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    batch.heading.replaceChildren(
      h('div', { class: 'section-heading' },
        h('h2', {}, batch.titleLink),
        h('code', {}, id.slice(0, 8))),
      h('dl', { class: 'batch-summary' }));
    batch.count = badge('');
    batch.heading.querySelector('.section-heading').append(batch.count);
    for (const r of runs) {
      let entry = cards.get(r.id);
      if (!entry) {
        const checkbox = h('input', { type: 'checkbox', 'aria-label': 'Compare ' + r.id,
          onChange: e => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); updateGallery(); } });
        const previewButton = h('button', { class: 'gallery-preview', 'aria-label': 'Preview ' + r.id,
          onClick: () => open([r.id]) });
        const title = h('h3', {}), version = badge(''), modelName = h('span', {}), timing = h('code', {}), cost = h('code', {}), usage = tokens();
        const card = h('article', { class: 'gallery-card', 'data-run-id': r.id }, previewButton,
          h('div', { class: 'gallery-card-body' },
            h('div', { class: 'section-heading' }, title, version),
            h('div', { class: 'section-heading' }, modelName,
              h('label', { class: 'inline-check' }, checkbox, 'Compare')),
            h('div', { class: 'gallery-token-usage' }, usage),
            h('footer', {}, timing, cost, pageLink('Permalink ↗', runURL(r.id), 'run-permalink'))));
        entry = { card, checkbox, previewButton, title, version, modelName, timing, cost, usage, previewState: 'idle', near: false };
        cards.set(r.id, entry);
        batch.grid.append(card);
        previewObserver.observe(card);
      }
      entry.run = r;
      entry.title.textContent = r.prompt_title;
      entry.version.textContent = 'v' + r.version;
      entry.modelName.textContent = runModelName(r);
      entry.timing.textContent = duration(r);
      entry.cost.textContent = money(r.metrics?.cost);
      entry.usage.textContent = tokenUsage(r.metrics);
      entry.previewButton.style.aspectRatio = data.settings.minWidth + ' / ' + data.settings.minHeight;
      // Changing viewport settings resizes the existing document without reloading it.
      const frame = entry.previewButton.querySelector('iframe');
      if (frame) {
        frame.style.width = data.settings.minWidth + 'px';
        frame.style.height = data.settings.minHeight + 'px';
      }
    }
  }
  gallerySynced = true;
  galleryControls.notice.replaceChildren();
  updateGallery();
}
function updateGallery() {
  syncFilterControls();
  galleryControls.clearButton.hidden = !hasGalleryFilters(routeState());
  const first = data.runs.find(r => selected.has(r.id));
  let visible = 0;
  for (const entry of cards.values()) {
    const r = entry.run;
    const matches = matchesRun(r, { prompt, model, effort, version, batch });
    entry.card.hidden = !matches;
    if (matches) visible++;
    entry.card.classList.toggle('selected', selected.has(r.id));
    entry.checkbox.checked = selected.has(r.id);
    entry.checkbox.disabled = !selected.has(r.id) && (selected.size >= 9 || !!first && first.prompt_id !== r.prompt_id);
    if (matches && entry.near && entry.previewState === 'idle') previewQueue.add(entry);
  }
  [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach((batch, index) => {
    batch.titleLink.href = urlFor({ batch: batch.section.dataset.batchId });
    const visibleRuns = batch.runs.filter(r => !cards.get(r.id).card.hidden), count = visibleRuns.length;
    const summaryKey = visibleRuns.map(r => r.id).join(',');
    if (batch.summaryKey !== summaryKey) {
      batch.summaryKey = summaryKey;
      const prompts = promptVersions(visibleRuns);
      const models = [...new Map(visibleRuns.map(r => [r.model_id + ':' + (r.config?.reasoningEffort || 'default'), runModelName(r)])).values()];
      batch.heading.querySelector('.batch-summary').replaceChildren(
        h('dt', {}, 'Prompts'), h('dd', {}, prompts.map((r, index) =>
          [index ? ' / ' : '', promptLabel(r.prompt_title + ' · v' + r.version, [r])])),
        h('dt', {}, 'Models'), h('dd', {}, models.join(' / ')));
    }
    batch.section.hidden = !count;
    // CSS order preserves iframe browsing contexts, unlike moving DOM nodes.
    batch.section.style.order = index;
    batch.count.textContent = count === batch.runs.length ? count + ' results' : count + '/' + batch.runs.length + ' results';
  });
  galleryControls.resultCount.textContent = visible + ' results';
  galleryControls.noResults.hidden = !!visible;
  galleryControls.selectionBar.hidden = !selected.size;
  galleryControls.selectionCount.textContent = selected.size + '/9 selected';
  galleryControls.compareButton.disabled = selected.size < 2;
  pumpPreviews();
}
function analytics() { return data.analytics || data.runs; }
function promptIndex() {
  if (data.prompts) return data.prompts;
  const groups = new Map();
  for (const run of data.runs) {
    if (!groups.has(run.prompt_id)) groups.set(run.prompt_id, []);
    groups.get(run.prompt_id).push(run);
  }
  return [...groups].map(([id, runs]) => {
    const versions = promptVersions(runs).sort((a, b) => b.version - a.version)
      .map(r => ({ id: r.version_id, version: r.version, title: r.prompt_title, content: r.prompt_content }));
    return { id, title: versions[0].title, versions };
  });
}
function withPrompt(run) {
  if (run.prompt_content !== undefined) return run;
  const version = promptIndex().find(p => p.id === run.prompt_id)?.versions.find(v => v.id === run.version_id || v.version === run.version);
  return { ...run, prompt_content: version?.content || 'Prompt text unavailable.' };
}
function promptsWithResults() {
  const completedPrompts = new Set(data.runs.map(run => run.prompt_id));
  return promptIndex().filter(p => completedPrompts.has(p.id));
}
function filterOptions(key) {
  const runs = analytics();
  if (key === 'prompt') return [['', 'All prompts'], ...promptsWithResults().map(p => [p.id, p.title])];
  if (key === 'model') return [['', 'All models'], ...new Map(runs.map(r => [r.model_id, name(r.model_name)]))];
  if (key === 'effort') return reasoningFilterOptions;
  if (key === 'version') return [['', 'All versions'], ...[...new Set(runs.filter(r => !prompt || r.prompt_id === prompt).map(r => r.version))]
    .sort((a, b) => b - a).map(v => [String(v), 'v' + v])];
  if (key === 'status') return [['', 'All statuses'], ...['completed', 'failed', 'queued', 'running', 'cancelled', 'interrupted'].map(s => [s, s])];
  const groups = new Map();
  for (const run of runs) if (run.batch_id && (!groups.has(run.batch_id) || groups.get(run.batch_id) > run.created_at)) groups.set(run.batch_id, run.created_at);
  return [['', 'All batches'], ...[...groups].sort((a, b) => b[1].localeCompare(a[1])).map(([id, date]) =>
    [id, new Date(date).toLocaleString() + ' · ' + id.slice(0, 8)])];
}
function filterSelect(label, key) {
  const value = routeState()[key], choices = filterOptions(key);
  if (value && !choices.some(([id]) => id === value)) choices.push([value, 'Unavailable · ' + value]);
  if (key === 'version' && choices.filter(([id]) => id).length <= 1) return null;
  return select(label, choices, value, next => changeFilter(key, next));
}
function syncFilterControls() {
  for (const key of ['prompt', 'model', 'effort', 'version', 'batch']) {
    const control = galleryControls[key + 'Filter'], value = routeState()[key], choices = filterOptions(key);
    if (value && !choices.some(([id]) => id === value)) choices.push([value, 'Unavailable · ' + value]);
    control.replaceChildren(...choices.map(([id, label]) => h('option', { value: id }, label)));
    control.value = value;
    if (key === 'version') control.hidden = choices.filter(([id]) => id).length <= 1;
  }
}
function renderPromptIndex() {
  const prompts = promptsWithResults();
  pageHost.replaceChildren(navigation(), h('main', { class: 'gallery-content' },
    h('div', { class: 'section-heading' }, h('h1', {}, 'Prompts'), badge(prompts.length + ' prompts')),
    prompts.length ? h('div', { class: 'public-prompts' }, prompts.map(p => {
      const versions = [...p.versions].sort((a, b) => b.version - a.version), latest = versions[0];
      const runs = data.runs.filter(r => r.prompt_id === p.id);
      const title = h('h2', {}), text = h('pre', {}), resultCount = h('div', { class: 'actions' });
      function showVersion(v) {
        title.textContent = v.title;
        text.textContent = v.content;
        const count = runs.filter(r => r.version === v.version).length;
        resultCount.replaceChildren(...[
          p.archived ? badge('archived') : null,
          pageLink(count + (count === 1 ? ' result' : ' results'),
            galleryURL(location.href, { prompt: p.id, version: String(v.version) }).href, 'badge prompt-results'),
        ].filter(Boolean));
      }
      const versionSelect = versions.length > 1 ? select('Version for ' + p.title,
        versions.map(v => [String(v.version), 'v' + v.version]), String(latest.version),
        value => showVersion(versions.find(v => String(v.version) === value))) : null;
      showVersion(latest);
      return h('article', { class: 'panel public-prompt', 'data-prompt-id': p.id },
        h('div', { class: 'section-heading' }, h('div', { class: 'public-prompt-title' }, title, versionSelect), resultCount), text);
    })) : empty('No prompts with results')));
}
function svgElement(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children.flat(Infinity)) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
function renderScatter() {
  const { points, models, missing } = plotData(analytics(), routeState(), metric);
  const pair = plotAxes[axes];
  const metricNames = { total: 'Total tokens', input: 'Input tokens', output: 'Output tokens', reasoning: 'Reasoning tokens' };
  const axisNames = { cost: 'Cost (USD)', time: 'Time (seconds)', tokens: metricNames[metric] };
  const countLabel = points.length + ' plotted' + (missing ? ' · ' + missing + ' missing ' + pair.y + '/' + pair.x : '');
  const controls = h('div', { class: 'toolbar standalone' },
    select('Plot axes', Object.entries(plotAxes).map(([id, pair]) => [id, pair.label]), axes, next => navigate(urlFor({ axes: next }))),
    filterSelect('Filter chart by prompt', 'prompt'), filterSelect('Filter chart by model', 'model'),
    filterSelect('Filter chart by reasoning level', 'effort'), filterSelect('Filter chart by prompt version', 'version'),
    filterSelect('Filter chart by batch', 'batch'), filterSelect('Filter chart by status', 'status'),
    pair.x === 'tokens' ? select('Token metric', Object.entries(metricNames), metric, next => navigate(urlFor({ metric: next }))) : null,
    hasGalleryFilters(routeState()) ? button('Clear all', clearFilters) : null, badge(countLabel));
  const content = h('main', { class: 'gallery-content scatter-content' },
    h('h1', {}, 'Scatterplot'), controls);
  pageHost.replaceChildren(navigation(), content);
  const modelIDs = [...new Set(analytics().map(r => r.model_id))].sort();
  const color = id => `hsl(${(modelIDs.indexOf(id) * 137.5 + 210) % 360} 65% 72%)`;
  const legend = h('div', { class: 'plot-legend', 'aria-label': 'Model visibility' }, models.map(([id, label]) =>
    h('button', { type: 'button', 'data-model-id': id, 'aria-pressed': String(!hiddenModels.includes(id)),
      onClick: () => {
        navigate(urlFor({ hiddenModels: hiddenModels.includes(id) ? hiddenModels.filter(value => value !== id) : [...hiddenModels, id] }));
        [...pageHost.querySelectorAll('.plot-legend button')].find(node => node.dataset.modelId === id)?.focus({ preventScroll: true });
      },
    }, h('i', { style: { background: color(id) } }), name(label))));
  if (!points.length) {
    content.append(h('div', { class: 'panel plot-panel' }, empty('No runs to plot'), legend));
    return;
  }
  const width = 1100, height = 560, left = 85, right = 30, top = 24, bottom = 65;
  const maxX = points.reduce((max, p) => Math.max(max, p.x), 0.000001) * 1.05;
  const maxY = points.reduce((max, p) => Math.max(max, p.y), 0.000001) * 1.05;
  const x = value => left + value / maxX * (width - left - right);
  const y = value => height - bottom - value / maxY * (height - top - bottom);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, class: 'scatterplot', role: 'group',
    'aria-label': axisNames[pair.y] + ' versus ' + axisNames[pair.x] });
  const tickTokens = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const tickCost = n => '$' + new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(n);
  const tick = (key, n) => key === 'cost' ? tickCost(n) : key === 'tokens' ? tickTokens(n) :
    new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(n);
  for (let i = 0; i <= 5; i++) {
    const tx = maxX * i / 5, cy = maxY * i / 5;
    svg.append(svgElement('line', { x1: x(tx), x2: x(tx), y1: top, y2: height - bottom, class: 'plot-grid' }),
      svgElement('line', { x1: left, x2: width - right, y1: y(cy), y2: y(cy), class: 'plot-grid' }),
      svgElement('text', { x: x(tx), y: height - bottom + 24, 'text-anchor': 'middle' }, tick(pair.x, tx)),
      svgElement('text', { x: left - 12, y: y(cy) + 4, 'text-anchor': 'end' }, tick(pair.y, cy)));
  }
  svg.append(svgElement('text', { x: width / 2, y: height - 12, 'text-anchor': 'middle', class: 'plot-axis' }, axisNames[pair.x]),
    svgElement('text', { x: 18, y: height / 2, 'text-anchor': 'middle', transform: `rotate(-90 18 ${height / 2})`, class: 'plot-axis' }, axisNames[pair.y]));
  function showPoint(point, trigger) {
    closePlot();
    const { run, tokens: used, cost, time } = point;
    plotTrigger = trigger;
    trigger.setAttribute('aria-describedby', plotPopup.id);
    trigger.querySelector('.plot-point').classList.add('inspected');
    plotPopup.replaceChildren(
      h('div', { class: 'section-heading' }, h('strong', {}, runModelName(run)), badge(run.status, run.status)),
      h('div', {}, run.prompt_title + ' · v' + run.version),
      h('div', { class: 'actions' }, h('code', {}, cost === null ? 'Cost —' : '$' + cost),
        h('code', {}, time === null ? 'Time —' : time.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' s'),
        h('code', {}, (used === null ? '—' : used.toLocaleString()) + ' ' + metricNames[metric].toLowerCase())),
      tokens(run.metrics),
      h('div', { class: 'actions' }, h('code', {}, new Date(run.created_at).toLocaleString()), h('code', {}, run.id.slice(0, 8))));
    plotPopup.hidden = false;
    positionPlot();
  }
  for (const point of points) {
    const r = point.run, label = runModelName(r) + ' · ' + r.prompt_title + ' · v' + r.version + ' · ' +
      axisNames[pair.x] + ': ' + tick(pair.x, point.x) + ' · ' + axisNames[pair.y] + ': ' + tick(pair.y, point.y) + ' · ' + r.status + ' · ' + r.id;
    const link = svgElement('a', { href: runURL(r.id), 'aria-label': label },
      svgElement('circle', { cx: x(point.x), cy: y(point.y), r: 6, fill: color(r.model_id),
        class: 'plot-point', 'data-run-id': r.id }));
    link.addEventListener('pointerenter', () => showPoint(point, link));
    link.addEventListener('pointerleave', schedulePlotClose);
    link.addEventListener('focus', () => showPoint(point, link));
    link.addEventListener('blur', schedulePlotClose);
    link.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(runURL(r.id));
    });
    svg.append(link);
  }
  content.append(h('div', { class: 'panel plot-panel' }, svg, legend));
}
function render() {
  closePrompt();
  closePlot();
  if (!data) return;
  if (!galleryView?.isConnected) mountGallery();
  galleryView.querySelector('.gallery-header').replaceWith(navigation());
  galleryView.hidden = !!compare.length || view !== 'gallery';
  comparisonHost.hidden = !compare.length;
  pageHost.hidden = !!compare.length || view === 'gallery';
  if (compare.length) comparison();
  else {
    comparisonHost.replaceChildren();
    if (view === 'prompts') renderPromptIndex();
    else if (view === 'scatter') renderScatter();
    else {
      pageHost.replaceChildren();
      if (!gallerySynced) syncGallery();
      else updateGallery();
    }
  }
}
function resultPreview(run) {
  if (run.status !== 'completed') return empty(run.status + ' · No completed implementation');
  if (typeof run.html === 'string') return preview(run.html, run.prompt_title + ' · ' + runModelName(run));
  const holder = h('div', { class: 'preview-loading' }, 'Loading…');
  ensureHTML(run).then(html => {
    if (holder.isConnected) holder.replaceWith(preview(html, run.prompt_title + ' · ' + runModelName(run)));
  }).catch(() => {
    if (holder.isConnected) holder.replaceChildren(errorBox('Preview unavailable'), button('Retry', () => holder.replaceWith(resultPreview(run))));
  });
  return holder;
}
async function showSource(run) {
  try {
    const html = await ensureHTML(run);
    modal(runModelName(run), h('div', {}, h('h3', {}, 'Prompt · v' + run.version), h('pre', {}, run.prompt_content), h('h3', {}, 'HTML'), h('pre', {}, html)));
  } catch { modal('Preview unavailable', errorBox('Could not load this implementation.')); }
}
function comparison() {
  closePrompt();
  const runs = compare.map(id => data.runs.find(r => r.id === id) || analytics().find(r => r.id === id));
  if (runs.some((r) => !r) || new Set(runs.map((r) => r.prompt_id)).size > 1) {
    comparisonHost.replaceChildren(
      errorBox('Unavailable results or different prompts'),
      button('Gallery', () => open([])),
    );
    return;
  }
  const cols = Math.min(columns ?? data.settings.columns, runs.length),
    rows = Math.ceil(runs.length / cols),
    available = data.runs.filter((r) => r.prompt_id === runs[0].prompt_id);
  const grid = h('div', {
    class: 'comparison-grid',
    style: {
      gridTemplateColumns: 'repeat(' + cols + ', minmax(' + data.settings.minWidth + 'px, 1fr))',
      gridAutoRows:
        'minmax(' +
        (data.settings.minHeight + 44) +
        'px, calc((100dvh - 76px - ' +
        (rows - 1) * 8 +
        'px) / ' +
        rows +
        '))',
    },
  });
  const toolbar = h(
    'header',
    { class: 'comparison-toolbar' },
    button('←', () => open([]), 'icon', { 'aria-label': 'Back to gallery' }),
    h('strong', {}, promptLabel(runs[0].prompt_title, runs.map(withPrompt))),
    badge(runs.length + ' results'),
    h(
      'div',
      { class: 'actions' },
      h('code', {}, data.settings.minWidth + '×' + data.settings.minHeight),
      select(
        'Comparison columns',
        Array.from({ length: runs.length }, (_, i) => [i + 1, i + 1 + ' columns']),
        cols,
        (v) => {
          navigate(urlFor({ columns: Number(v) }));
        },
      ),
      runs.length < 9
        ? select(
            'Add implementation',
            [
              ['', '+ Add'],
              ...available
                .filter((r) => !compare.includes(r.id))
                .map((r) => [
                  r.id,
                  runModelName(r) + ' · v' + r.version + ' · ' + r.id.slice(0, 6),
                ]),
            ],
            '',
            (v) => {
              if (v) open([...compare, v]);
            },
          )
        : null,
      button(
        '⛶',
        async () => {
          try {
            document.fullscreenElement
              ? await document.exitFullscreen()
              : await document.documentElement.requestFullscreen();
          } catch {
            modal('Fullscreen unavailable', h('p', {}, 'Open the gallery in a browser tab.'));
          }
        },
        'icon',
        { 'aria-label': 'Toggle fullscreen' },
      ),
    ),
  );
  for (const [i, r] of runs.entries())
    grid.append(
      h(
        'section',
        { class: 'comparison-tile' },
        h(
          'header',
          { class: 'tile-heading' },
          h('code', {}, String(i + 1).padStart(2, '0')),
          pageLink(runModelName(r) + ' · v' + r.version + ' · ' + r.id.slice(0, 6), runURL(r.id), 'tile-result'),
          h('code', {}, duration(r)),
          tokens(r.metrics),
          h('code', {}, money(r.metrics?.cost)),
          r.status === 'completed' ? button(
            '</>',
            () => showSource(r),
            'icon',
            { 'aria-label': 'View source ' + r.id },
          ) : badge(r.status, r.status),
          runs.length > 1
            ? button('×', () => open(compare.filter((id) => id !== r.id)), 'icon', {
                'aria-label': 'Remove ' + r.id,
              })
            : null,
        ),
        resultPreview(r),
      ),
    );
  comparisonHost.replaceChildren(
    h('div', { class: 'comparison-app' }, toolbar, h('div', { class: 'comparison-scroll' }, grid)),
  );
}
readURL();
await load();
