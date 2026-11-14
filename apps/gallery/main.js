import {
  h,
  button,
  link,
  select,
  input,
  badge,
  name,
  money,
  duration,
  date,
  replace,
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
  search = '',
  prompt = '',
  model = '',
  sort = 'newest';
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
    const response = await fetch(exported ? new URL('data.json', location.href) : '/api/gallery');
    if (!response.ok) throw Error('Gallery unavailable');
    data = await response.json();
    render();
  } catch (e) {
    root.replaceChildren(errorBox(e.message), button('Retry', load));
  }
}
function render() {
  if (!data) return;
  if (compare.length) {
    comparison();
    return;
  }
  const first = data.runs.find((r) => selected.has(r.id));
  const rows = data.runs
    .filter(
      (r) =>
        (!prompt || r.prompt_id === prompt) &&
        (!model || r.model_id === model) &&
        (r.prompt_title + ' ' + r.model_name).toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === 'newest'
        ? b.created_at.localeCompare(a.created_at)
        : a.created_at.localeCompare(b.created_at),
    );
  const app = h(
    'div',
    { class: 'gallery-app' },
    h(
      'header',
      { class: 'gallery-header' },
      h('a', { href: './', class: 'brand' }, h('span', { class: 'brand-mark' }, '⌘'), 'ONESHOT'),
      h('span', {}, '/ gallery'),
      data.mode === 'local' ? link('Admin ↗', '/') : badge('SNAPSHOT'),
    ),
  );
  const main = h(
    'main',
    { class: 'gallery-content' },
    h(
      'div',
      { class: 'page-heading' },
      h('h1', {}, 'Gallery'),
      h('div', { class: 'actions' }, badge(data.runs.length + ' results'), button('Refresh', load)),
    ),
    h(
      'div',
      { class: 'toolbar standalone' },
      input(
        'Search gallery',
        search,
        (v) => {
          search = v;
          render();
        },
        { type: 'text', placeholder: 'Search implementations' },
      ),
      select(
        'Filter gallery by prompt',
        [['', 'All prompts'], ...new Map(data.runs.map((r) => [r.prompt_id, r.prompt_title]))],
        prompt,
        (v) => {
          prompt = v;
          render();
        },
      ),
      select(
        'Filter gallery by model',
        [['', 'All models'], ...new Map(data.runs.map((r) => [r.model_id, name(r.model_name)]))],
        model,
        (v) => {
          model = v;
          render();
        },
      ),
      select(
        'Sort gallery by date',
        [
          ['newest', 'Newest first'],
          ['oldest', 'Oldest first'],
        ],
        sort,
        (v) => {
          sort = v;
          render();
        },
      ),
    ),
  );
  const grid = h('div', { class: 'gallery-grid' });
  for (const r of rows) {
    const card = h(
      'article',
      { class: 'gallery-card' + (selected.has(r.id) ? ' selected' : '') },
      h(
        'button',
        { class: 'gallery-preview', 'aria-label': 'Preview ' + r.id, onClick: () => open([r.id]) },
        preview(r.html, r.prompt_title, {
          thumbnail: true,
          width: data.settings.minWidth,
          height: data.settings.minHeight,
        }),
      ),
      h(
        'div',
        { class: 'gallery-card-body' },
        h('div', { class: 'section-heading' }, h('h3', {}, r.prompt_title), badge('v' + r.version)),
        h(
          'div',
          { class: 'section-heading' },
          h('span', {}, name(r.model_name)),
          h(
            'label',
            { class: 'inline-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': 'Compare ' + r.id,
              checked: selected.has(r.id),
              disabled:
                !selected.has(r.id) &&
                (selected.size >= 9 || (first && first.prompt_id !== r.prompt_id)),
              onChange: () => {
                selected.has(r.id) ? selected.delete(r.id) : selected.add(r.id);
                render();
              },
            }),
            'Compare',
          ),
        ),
        h(
          'footer',
          {},
          h('code', {}, date(r.created_at)),
          h('code', {}, duration(r)),
          h('code', {}, money(r.metrics?.cost)),
        ),
      ),
    );
    grid.append(card);
  }
  main.append(rows.length ? grid : empty('No results'));
  if (selected.size)
    main.append(
      h(
        'div',
        { class: 'selection' },
        h('span', {}, selected.size + '/9 selected'),
        button('Clear', () => {
          selected.clear();
          render();
        }),
        button('Compare →', () => open([...selected]), 'primary', { disabled: selected.size < 2 }),
      ),
    );
  app.append(main);
  replace(root, app);
}
function comparison() {
  const runs = compare.map((id) => data.runs.find((r) => r.id === id));
  if (runs.some((r) => !r) || new Set(runs.map((r) => r.prompt_id)).size > 1) {
    root.replaceChildren(
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
                  name(r.model_name) + ' · v' + r.version + ' · ' + r.id.slice(0, 6),
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
          select(
            'Result in tile ' + (i + 1),
            available
              .filter((n) => n.id === r.id || !compare.includes(n.id))
              .map((n) => [
                n.id,
                name(n.model_name) + ' · v' + n.version + ' · ' + n.id.slice(0, 6),
              ]),
            r.id,
            (v) => open(compare.map((id, index) => (index === i ? v : id))),
          ),
          h('code', {}, duration(r)),
          h('code', {}, money(r.metrics?.cost)),
          button(
            '</>',
            () =>
              modal(
                name(r.model_name),
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
        preview(r.html, r.prompt_title + ' · ' + r.model_name),
      ),
    );
  root.replaceChildren(
    h('div', { class: 'comparison-app' }, toolbar, h('div', { class: 'comparison-scroll' }, grid)),
  );
}
readURL();
await load();
