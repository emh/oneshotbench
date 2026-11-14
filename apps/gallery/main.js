import {
  h,
  button,
  select,
  badge,
  name,
  runModelName,
  reasoningFilterOptions,
  runEffort,
  money,
  tokens,
  tokenUsage,
  duration,
  modal,
  empty,
  errorBox,
  preview,
} from '../shared/dom.js';
const root = document.getElementById('root');
let data,
  selected = new Set(),
  compare = [],
  columns = null,
  prompt = '',
  model = '',
  effort = '';
function readURL() {
  compare = [
    ...new Set(
      (new URLSearchParams(location.search).get('compare') || '').split(',').filter(Boolean),
    ),
  ].slice(0, 9);
}
function open(ids) {
  compare = ids;
  const url = new URL(location.href);
  ids.length ? url.searchParams.set('compare', ids.join(',')) : url.searchParams.delete('compare');
  history.pushState({}, '', url);
  render();
}
window.addEventListener('popstate', () => {
  readURL();
  render();
});
async function load() {
  try {
    const exported = document.querySelector('meta[name="oneshot-export"]');
    const endpoint = document.querySelector('meta[name="oneshot-api"]')?.content || '';
    const response = await fetch(exported ? new URL('data.json', location.href) : endpoint + '/api/gallery');
    if (!response.ok) throw Error('Gallery unavailable');
    data = await response.json();
    syncGallery();
    render();
  } catch (e) {
    (galleryView?.isConnected ? galleryControls.notice : root).replaceChildren(errorBox(e.message), button('Retry', load));
  }
}
// Keep cards mounted: removing or reparenting an iframe resets its document.
let galleryView, comparisonHost, galleryControls;
const cards = new Map(), batches = new Map();
function mountGallery() {
  const resultCount = badge(''), batchList = h('div', { class: 'gallery-batches' });
  const noResults = empty('No results');
  const selectionCount = h('span', {});
  const compareButton = button('Compare →', () => open([...selected]), 'primary');
  const selectionBar = h('div', { class: 'selection', hidden: true }, selectionCount,
    button('Clear', () => { selected.clear(); updateGallery(); }), compareButton);
  const promptFilter = select('Filter gallery by prompt', [], prompt, v => { prompt = v; updateGallery(); });
  const modelFilter = select('Filter gallery by model', [], model, v => { model = v; updateGallery(); });
  const effortFilter = select('Filter gallery by reasoning level', reasoningFilterOptions, effort, v => { effort = v; updateGallery(); });
  const notice = h('div', { role: 'status' });
  galleryView = h('div', { class: 'gallery-app' },
    h('header', { class: 'gallery-header' },
      h('a', { href: './', class: 'brand' }, h('span', { class: 'brand-mark' }, '⌘'), 'ONESHOT')),
    h('main', { class: 'gallery-content' },
      h('div', { class: 'toolbar standalone gallery-filters' }, promptFilter, modelFilter, effortFilter, resultCount),
      notice, batchList, noResults, selectionBar));
  comparisonHost = h('div', { hidden: true });
  galleryControls = { resultCount, batchList, noResults, selectionCount, selectionBar,
    compareButton, promptFilter, modelFilter, notice };
  root.replaceChildren(galleryView, comparisonHost);
}
function syncGallery() {
  if (!galleryView?.isConnected) mountGallery();
  const ids = new Set(data.runs.map(r => r.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  for (const [id, entry] of cards) if (!ids.has(id)) { entry.card.remove(); cards.delete(id); }
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
    const prompts = [...new Map(runs.map(r => [r.version_id || r.prompt_id + ':' + r.version,
      r.prompt_title + ' · v' + r.version])).values()];
    const models = [...new Map(runs.map(r => [r.model_id + ':' + (r.config?.reasoningEffort || 'default'), runModelName(r)])).values()];
    batch.heading.replaceChildren(
      h('div', { class: 'section-heading' },
        h('h2', {}, h('time', { dateTime: batch.createdAt }, new Date(batch.createdAt).toLocaleString(undefined,
          { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))),
        h('code', {}, id.slice(0, 8))),
      h('dl', { class: 'batch-summary' },
        h('dt', {}, 'Prompts'), h('dd', {}, prompts.join(' / ')),
        h('dt', {}, 'Models'), h('dd', {}, models.join(' / '))));
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
            h('footer', {}, timing, cost)));
        entry = { card, checkbox, previewButton, title, version, modelName, timing, cost, usage };
        cards.set(r.id, entry);
        batch.grid.append(card);
      }
      entry.run = r;
      entry.title.textContent = r.prompt_title;
      entry.version.textContent = 'v' + r.version;
      entry.modelName.textContent = runModelName(r);
      entry.timing.textContent = duration(r);
      entry.cost.textContent = money(r.metrics?.cost);
      entry.usage.textContent = tokenUsage(r.metrics);
      if (entry.html !== r.html) {
        entry.previewButton.replaceChildren(preview(r.html, r.prompt_title + ' · ' + runModelName(r) + ' · ' + r.id,
          { thumbnail: true, width: data.settings.minWidth, height: data.settings.minHeight }));
        entry.html = r.html;
      }
      // Changing viewport settings resizes the existing document without reloading it.
      const frame = entry.previewButton.querySelector('iframe');
      frame.style.width = data.settings.minWidth + 'px';
      frame.style.height = data.settings.minHeight + 'px';
    }
  }
  function options(control, values, current) {
    control.replaceChildren(...values.map(([value, label]) => h('option', { value }, label)));
    control.value = current;
  }
  options(galleryControls.promptFilter, [['', 'All prompts'], ...new Map(data.runs.map(r => [r.prompt_id, r.prompt_title]))], prompt);
  options(galleryControls.modelFilter, [['', 'All models'], ...new Map(data.runs.map(r => [r.model_id, name(r.model_name)]))], model);
  galleryControls.notice.replaceChildren();
  updateGallery();
}
function updateGallery() {
  const first = data.runs.find(r => selected.has(r.id));
  let visible = 0;
  for (const entry of cards.values()) {
    const r = entry.run;
    const matches = (!prompt || r.prompt_id === prompt) && (!model || r.model_id === model) &&
      (!effort || runEffort(r) === effort);
    entry.card.hidden = !matches;
    if (matches) visible++;
    entry.card.classList.toggle('selected', selected.has(r.id));
    entry.checkbox.checked = selected.has(r.id);
    entry.checkbox.disabled = !selected.has(r.id) && (selected.size >= 9 || !!first && first.prompt_id !== r.prompt_id);
  }
  [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach((batch, index) => {
    const count = batch.runs.filter(r => !cards.get(r.id).card.hidden).length;
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
}
function render() {
  if (!data) return;
  if (!galleryView?.isConnected) syncGallery();
  galleryView.hidden = !!compare.length;
  comparisonHost.hidden = !compare.length;
  if (compare.length) comparison();
  else { comparisonHost.replaceChildren(); updateGallery(); }
}
function comparison() {
  const runs = compare.map((id) => data.runs.find((r) => r.id === id));
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
    h('strong', {}, runs[0].prompt_title),
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
          columns = Number(v);
          comparison();
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
          h('span', { class: 'tile-result', title: runModelName(r) + ' · v' + r.version + ' · ' + r.id },
            runModelName(r) + ' · v' + r.version + ' · ' + r.id.slice(0, 6)),
          h('code', {}, duration(r)),
          tokens(r.metrics),
          h('code', {}, money(r.metrics?.cost)),
          button(
            '</>',
            () =>
              modal(
                runModelName(r),
                h(
                  'div',
                  {},
                  h('h3', {}, 'Prompt · v' + r.version),
                  h('pre', {}, r.prompt_content),
                  h('h3', {}, 'HTML'),
                  h('pre', {}, r.html),
                ),
              ),
            'icon',
            { 'aria-label': 'View source ' + r.id },
          ),
          runs.length > 1
            ? button('×', () => open(compare.filter((id) => id !== r.id)), 'icon', {
                'aria-label': 'Remove ' + r.id,
              })
            : null,
        ),
        preview(r.html, r.prompt_title + ' · ' + runModelName(r)),
      ),
    );
  comparisonHost.replaceChildren(
    h('div', { class: 'comparison-app' }, toolbar, h('div', { class: 'comparison-scroll' }, grid)),
  );
}
readURL();
await load();
