import {
  h,
  button,
  link,
  field,
  select,
  input,
  badge,
  name,
  runModelName,
  reasoningFilterOptions,
  runEffort,
  money,
  tokens,
  duration,
  date,
  failure,
  api,
  replace,
  toast,
  modal,
  empty,
  errorBox,
} from '../shared/dom.js';
const root = document.getElementById('root');
let state,
  page = location.hash.slice(1) || 'runs',
  modelCatalog = [],
  catalogError = '',
  catalogBusy = false;
const filters = {
  runs: { search: '', model: '', prompt: '', effort: '', status: '', sort: 'newest' },
  prompts: { search: '' },
  models: { search: '', provider: '', enabled: false },
};
let selected = new Set(),
  settingsDraft = null;
const viewedVersions = new Map();
async function refresh() {
  try {
    const next = await api('/state');
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      render();
    }
  } catch (e) {
    if (!state) root.replaceChildren(errorBox(e.message));
  }
}
async function mutate(path, method, body, message) {
  const result = await api(path, method, body);
  await refresh();
  if (message) toast(message);
  return result;
}
window.addEventListener('hashchange', () => {
  page = location.hash.slice(1) || 'runs';
  settingsDraft = null;
  render();
});
function heading(title, ...actions) {
  return h(
    'div',
    { class: 'page-heading' },
    h('h1', {}, title),
    h('div', { class: 'actions' }, actions),
  );
}
function render() {
  if (!state) return;
  const titles = { runs: 'Runs', prompts: 'Prompts', models: 'Models', settings: 'Settings' };
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('a', { class: 'brand', href: '#runs' }, h('span', { class: 'brand-mark' }, '⌘'), 'ONESHOT'),
    h(
      'nav',
      {},
      Object.entries(titles).map(([id, title]) =>
        h(
          'a',
          { href: '#' + id, class: page === id ? 'active' : '' },
          h(
            'span',
            { class: 'nav-index' },
            { runs: '01', prompts: '02', models: '03', settings: '04' }[id],
          ),
          title,
          id === 'runs' ? badge(state.runs.length) : null,
        ),
      ),
    ),
    h(
      'div',
      { class: 'sidebar-bottom' },
      link('Gallery ↗', state.galleryUrl || '/gallery/'),
      h('div', { class: 'environment' }, h('i', {}), state.environment || 'LOCAL', h('span', {}, 'v0.2')),
    ),
  );
  const main = h(
    'main',
    { class: 'main' },
    h(
      'header',
      { class: 'topbar' },
      h('span', {}, 'workspace / ', h('strong', {}, titles[page] || 'Runs')),
      badge(location.hostname),
    ),
  );
  const content = h('div', { class: 'content' });
  main.append(content);
  if (page === 'prompts') renderPrompts(content);
  else if (page === 'models') renderModels(content);
  else if (page === 'settings') renderSettings(content);
  else renderRuns(content);
  replace(root, h('div', { class: 'shell' }, sidebar, main));
}
function renderRuns(container) {
  const f = filters.runs;
  const completed = state.runs.filter((r) => r.status === 'completed'),
    active = state.runs.filter((r) => ['queued', 'running'].includes(r.status));
  container.append(
    heading(
      'Runs',
      link('Gallery ↗', '/gallery/'),
      button('+ New run', () => newRun(), 'primary'),
    ),
  );
  const stats = [
    ['TOTAL', state.runs.length],
    ['RUNNING', active.length],
    ['COMPLETED', completed.length],
    ['RECORDED COST', money(state.runs.reduce((s, r) => s + (r.metrics?.cost || 0), 0))],
  ];
  container.append(
    h(
      'div',
      { class: 'stats' },
      stats.map(([label, value]) => h('div', {}, h('span', {}, label), h('strong', {}, value))),
    ),
  );
  const change = (key, value) => {
    f[key] = value;
    render();
  };
  const rows = state.runs
    .filter(
      (r) =>
        (!f.model || r.model_id === f.model) &&
        (!f.prompt || r.prompt_id === f.prompt) &&
        (!f.effort || runEffort(r) === f.effort) &&
        (!f.status || r.status === f.status) &&
        (r.prompt_title + ' ' + runModelName(r) + ' ' + r.id)
          .toLowerCase()
          .includes(f.search.toLowerCase()),
    )
    .sort((a, b) =>
      f.sort === 'newest'
        ? b.created_at.localeCompare(a.created_at)
        : a.created_at.localeCompare(b.created_at),
    );
  const panel = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'toolbar' },
      input('Search runs', f.search, (v) => change('search', v), {
        placeholder: 'Search runs',
        type: 'text',
      }),
      select(
        'Filter by model',
        [['', 'All models'], ...new Map(state.runs.map((r) => [r.model_id, name(r.model_name)]))],
        f.model,
        (v) => change('model', v),
      ),
      select(
        'Filter by prompt',
        [['', 'All prompts'], ...new Map(state.runs.map((r) => [r.prompt_id, r.prompt_title]))],
        f.prompt,
        (v) => change('prompt', v),
      ),
      select(
        'Filter by status',
        [
          ['', 'All statuses'],
          ...['completed', 'running', 'queued', 'failed', 'cancelled', 'interrupted'].map((s) => [
            s,
            s,
          ]),
        ],
        f.status,
        (v) => change('status', v),
      ),
      select('Filter by reasoning level', reasoningFilterOptions, f.effort, v => change('effort', v)),
      select(
        'Sort by date',
        [
          ['newest', 'Newest first'],
          ['oldest', 'Oldest first'],
        ],
        f.sort,
        (v) => change('sort', v),
      ),
    ),
  );
  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ['', 'IMPLEMENTATION', 'MODEL', 'STATUS', 'DURATION', 'TOKENS', 'COST', 'CREATED', ''].map((t) =>
          h('th', {}, t),
        ),
      ),
    ),
  );
  const first = state.runs.find((r) => selected.has(r.id));
  table.append(
    h(
      'tbody',
      {},
      rows.map((r) =>
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              'aria-label': 'Select ' + r.id,
              checked: selected.has(r.id),
              disabled:
                r.status !== 'completed' ||
                (!selected.has(r.id) &&
                  (selected.size >= 9 || (first && first.prompt_id !== r.prompt_id))),
              onChange: () => {
                selected.has(r.id) ? selected.delete(r.id) : selected.add(r.id);
                render();
              },
            }),
          ),
          h(
            'td',
            {},
            button(r.prompt_title, () => detail(r.id), 'text'),
            h(
              'div',
              { class: 'row-meta' },
              badge('v' + r.version),
              h('code', {}, r.id.slice(0, 8)),
            ),
          ),
          h(
            'td',
            {},
            h('strong', { class: 'model-name' }, runModelName(r)),
            h('small', {}, r.model_id),
          ),
          h(
            'td',
            {},
            badge(r.status, r.status),
            failure(r) ? button(failure(r), () => detail(r.id), 'failure') : null,
          ),
          h('td', { class: 'mono' }, duration(r)),
          h('td', {}, tokens(r.metrics)),
          h('td', { class: 'mono' }, money(r.metrics?.cost)),
          h('td', { class: 'mono' }, date(r.created_at)),
          h(
            'td',
            {},
            button('↗', () => detail(r.id), 'icon', { 'aria-label': 'Open run ' + r.id }),
          ),
        ),
      ),
    ),
  );
  panel.append(rows.length ? h('div', { class: 'table-scroll' }, table) : empty('No runs'));
  panel.append(h('footer', { class: 'panel-footer' }, rows.length + ' results'));
  container.append(panel);
  if (selected.size)
    container.append(
      h(
        'div',
        { class: 'selection' },
        h('span', {}, selected.size + '/9 selected'),
        button('Clear', () => {
          selected.clear();
          render();
        }),
        link(
          'Compare ↗',
          '/gallery/?compare=' + [...selected].join(','),
          selected.size >= 2 ? 'primary' : 'disabled',
        ),
      ),
    );
}
function newRun(initialPromptId, initialVersionId) {
  const promptIds = new Set(initialPromptId ? [initialPromptId] : []),
    promptVersions = Object.fromEntries(state.prompts.map(p => [p.id,
      p.id === initialPromptId ? initialVersionId || p.version_id : p.version_id])),
    modelIds = new Set(state.settings.selectedModels.map((m) => m.id));
  const enabledModels = state.settings.selectedModels;
  const efforts = new Map(enabledModels.map(m => [m.id, new Set(['default'])]));
  const modelArea = h('div', { class: 'choices' }, h('div', { class: 'empty' }, 'Loading models…'));
  let capabilitiesLoaded = false, submitting = false;
  const summary = h('code', {}),
    error = h('div', {});
  let dialog;
  const submit = button(
    'Start run',
    async () => {
      if (submitting) return;
      submitting = true;
      submit.disabled = true;
      error.replaceChildren();
      try {
        await mutate(
          '/runs',
          'POST',
          { promptIds: [...promptIds],
            modelVariants: [...modelIds].flatMap(modelId => [...efforts.get(modelId)].map(effort =>
              ({ modelId, ...(effort !== 'default' ? { reasoningEffort: effort } : {}) }))),
            promptVersions: Object.fromEntries([...promptIds].map(id => [id, promptVersions[id]])) },
          'Run submitted',
        );
        dialog.close();
        location.hash = 'runs';
      } catch (e) {
        error.replaceChildren(errorBox(e.message));
      } finally {
        submitting = false;
        update();
      }
    },
    'primary',
  );
  function update() {
    const n = promptIds.size * [...modelIds].reduce((sum, id) => sum + efforts.get(id).size, 0);
    modelArea.querySelectorAll('fieldset').forEach(node => { node.disabled = !modelIds.has(node.dataset.modelId); });
    for (const [control, ids, total] of [[allPrompts, promptIds, state.prompts.length], [allModels, modelIds, enabledModels.length]]) {
      control.checked = total > 0 && ids.size === total;
      control.indeterminate = ids.size > 0 && ids.size < total;
      control.disabled = !total;
    }
    grid.querySelectorAll('[data-choice-id]').forEach(node => {
      node.checked = (node.dataset.selection === 'models' ? modelIds : promptIds).has(node.dataset.choiceId);
    });
    modelArea.querySelectorAll('[data-effort]').forEach(node => {
      node.checked = efforts.get(node.closest('fieldset').dataset.modelId).has(node.dataset.effort);
    });
    summary.textContent = n + ' implementations';
    submit.disabled = submitting || !capabilitiesLoaded || !n || n > 200 || !state.keyConfigured || [...modelIds].some(id => !efforts.get(id).size);
  }
  function choice(id, label, meta, set) {
    return h(
      'label',
      { class: 'choice' },
      h('input', {
        type: 'checkbox',
        'data-choice-id': id,
        'data-selection': set === modelIds ? 'models' : 'prompts',
        checked: set.has(id),
        onChange: (e) => {
          e.target.checked ? set.add(id) : set.delete(id);
          update();
        },
      }),
      h('span', {}, label, h('small', {}, meta)),
    );
  }
  const allPrompts = h('input', { type: 'checkbox', 'aria-label': 'Select all prompts', onChange: event => {
    promptIds.clear();
    if (event.target.checked) state.prompts.forEach(p => promptIds.add(p.id));
    update();
  } });
  const allModels = h('input', { type: 'checkbox', 'aria-label': 'Select all models', onChange: event => {
    modelIds.clear();
    if (event.target.checked) enabledModels.forEach(m => {
      modelIds.add(m.id);
      efforts.set(m.id, new Set(['default']));
    });
    update();
  } });
  const grid = h(
    'div',
    { class: 'split' },
    h(
      'section',
      {},
      h(
        'div',
        { class: 'section-heading' },
        h('h3', {}, 'Prompts'),
        h('label', { class: 'inline-check' }, allPrompts, 'All'),
      ),
      h(
        'div',
        { class: 'choices', 'data-prompts': '' },
        state.prompts.map((p) => {
          const title = h('span', {}, p.versions.find(v => v.id === promptVersions[p.id]).title);
          const version = select('Run version for ' + p.title,
            p.versions.map(v => [v.id, 'v' + v.version + (v.id === p.version_id ? ' · latest' : '')]),
            promptVersions[p.id], id => {
              promptVersions[p.id] = id;
              title.textContent = p.versions.find(v => v.id === id).title;
            });
          return h('div', { class: 'prompt-choice' },
            choice(p.id, title, '', promptIds), version);
        }),
      ),
    ),
    h(
      'section',
      {},
      h('div', { class: 'section-heading' }, h('h3', {}, 'Models'),
        h('label', { class: 'inline-check' }, allModels, 'All')),
      modelArea,
    ),
  );
  dialog = modal(
    'New run',
    h(
      'div',
      {},
      grid,
      error,
    ),
    [summary, button('Cancel', () => dialog.close()), submit],
  );
  async function loadChoices() {
    try {
      const catalog = (await api('/models')).models;
      if (!dialog.isConnected) return;
      modelArea.replaceChildren(...enabledModels.map(m => {
        const capabilities = catalog.find(n => n.id === m.id);
        const options = capabilities?.reasoningEfforts || [];
        const fieldset = options.length ? h('fieldset', { class: 'reasoning-choices', 'data-model-id': m.id },
          h('legend', {}, 'Reasoning effort'),
          ['default', ...options].map(effort => {
            const checkbox = h('input', { type: 'checkbox', checked: effort === 'default',
              'data-effort': effort,
              'aria-label': name(m.name) + ' reasoning ' + effort,
              onChange: event => {
                const values = efforts.get(m.id);
                if (event.target.checked) {
                  if (effort === 'default') values.clear();
                  else values.delete('default');
                  values.add(effort);
                } else values.delete(effort);
                update();
              } });
            return h('label', { class: 'inline-check' }, checkbox,
              effort === 'default' ? 'Default' + (capabilities.defaultReasoningEffort ? ' (' + capabilities.defaultReasoningEffort + ')' : '') : effort);
          })) : null;
        return h('div', { class: 'run-model-choice' }, choice(m.id, name(m.name), m.id, modelIds), fieldset);
      }));
      if (!enabledModels.length) modelArea.append(link('Configure models', '#models'));
      capabilitiesLoaded = true;
      update();
    } catch (e) {
      if (dialog.isConnected) modelArea.replaceChildren(errorBox(e.message), button('Retry', loadChoices));
    }
  }
  update();
  loadChoices();
}
function renderPrompts(container) {
  const f = filters.prompts;
  container.append(
    heading(
      'Prompts',
      button('+ New prompt', () => editPrompt(), 'primary'),
    ),
  );
  container.append(
    h(
      'div',
      { class: 'toolbar standalone' },
      input(
        'Search prompts',
        f.search,
        (v) => {
          f.search = v;
          render();
        },
        { placeholder: 'Search prompts', type: 'text' },
      ),
      badge(state.prompts.length),
    ),
  );
  container.append(
    h(
      'div',
      { class: 'prompt-list' },
      state.prompts
        .map(p => {
          const v = p.versions.find(v => v.id === viewedVersions.get(p.id)) || p.versions[0];
          return { p, v };
        })
        .filter(({ v }) => (v.title + ' ' + v.content).toLowerCase().includes(f.search.toLowerCase()))
        .map(({ p, v }) =>
          h(
            'article',
            { class: 'prompt-card' },
            h(
              'div',
              { class: 'section-heading' },
              button(v.title, () => viewPromptVersion(p, v), 'text title'),
              h(
                'div',
                { class: 'actions' },
                badge(v.category),
                select('View version for ' + p.title,
                  p.versions.map(version => [version.id, 'v' + version.version + (version.id === p.version_id ? ' · latest' : '')]),
                  v.id, id => {
                    if (id === p.version_id) viewedVersions.delete(p.id);
                    else viewedVersions.set(p.id, id);
                    render();
                  }),
                badge(v.locked_at ? 'locked' : 'draft'),
                button('×', () => archive(p), 'icon', { 'aria-label': 'Archive ' + p.title }),
              ),
            ),
            h('p', { class: 'prompt-content' }, v.content),
            h(
              'footer',
              {},
              h('code', {}, state.runs.filter(r => r.version_id === v.id).length + ' runs'),
              h('div', { class: 'actions' },
                button('View', () => viewPromptVersion(p, v), 'text'),
                button(v.id === p.version_id ? 'Edit' : 'Edit latest', () => editPrompt(p), 'text'),
                button('Run v' + v.version, () => newRun(p.id, v.id), 'text')),
            ),
          ),
        ),
    ),
  );
}
function viewPromptVersion(p, v) {
  let dialog;
  dialog = modal(v.title + ' · v' + v.version,
    h('div', {}, badge(v.locked_at ? 'locked' : 'draft'), h('pre', {}, v.content)),
    [button('Close', () => dialog.close()), button('Run v' + v.version, () => {
      dialog.close();
      newRun(p.id, v.id);
    }, 'primary')]);
}
function editPrompt(p) {
  let title = p?.title || '',
    category = p?.category || 'Application',
    content = p?.content || '';
  const error = h('div', {});
  let dialog;
  const form = h(
    'form',
    {},
    h(
      'div',
      { class: 'fields' },
      field(
        'Name',
        input('Prompt name', title, (v) => (title = v), { required: true, maxLength: 160 }),
      ),
      field(
        'Category',
        input('Category', category, (v) => (category = v), { required: true, maxLength: 60 }),
      ),
    ),
    field(
      'Prompt',
      h('textarea', {
        'aria-label': 'Prompt',
        value: content,
        required: true,
        rows: 12,
        onInput: (e) => (content = e.target.value),
      }),
    ),
    error,
  );
  if (p) {
    const history = h('details', {}, h('summary', {}, 'Versions (' + p.versions.length + ')'));
    p.versions.forEach((v) =>
      history.append(
        h(
          'details',
          { class: 'version' },
          h(
            'summary',
            {},
            'v' + v.version + ' · ' + v.title + ' · ' + (v.locked_at ? 'locked' : 'draft'),
          ),
          h('pre', {}, v.content),
        ),
      ),
    );
    form.append(history);
  }
  const save = button(
    p?.locked_at ? 'Save v' + (p.version + 1) : 'Save',
    () => form.requestSubmit(),
    'primary',
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await mutate(
        p ? '/prompts/' + p.id : '/prompts',
        p ? 'PATCH' : 'POST',
        { title, category, content, baseVersionId: p?.version_id },
        'Prompt saved',
      );
      dialog.close();
    } catch (e) {
      error.replaceChildren(errorBox(e.message));
      save.disabled = false;
    }
  });
  dialog = modal(p ? 'Edit prompt · v' + p.version : 'New prompt', form, [
    button('Cancel', () => dialog.close()),
    save,
  ]);
}
function archive(p) {
  let dialog;
  const error = h('div', {});
  dialog = modal('Archive prompt', h('div', {}, h('p', {}, p.title), error), [
    button('Cancel', () => dialog.close()),
    button(
      'Archive',
      async () => {
        try {
          await mutate('/prompts/' + p.id, 'DELETE', {}, 'Prompt archived');
          dialog.close();
        } catch (e) {
          error.replaceChildren(errorBox(e.message));
        }
      },
      'danger',
    ),
  ]);
}
async function loadModels(force = false) {
  catalogBusy = true;
  catalogError = '';
  render();
  try {
    modelCatalog = (await api('/models' + (force ? '?refresh=1' : ''))).models;
  } catch (e) {
    catalogError = e.message;
  } finally {
    catalogBusy = false;
    render();
  }
}
const modelProvider = model => model.id.split('/')[0].replace(/^~/, '') || 'other';
function renderModels(container) {
  if (!modelCatalog.length && !catalogBusy && !catalogError) queueMicrotask(() => loadModels());
  const f = filters.models,
    enabled = state.settings.selectedModels;
  const all = [...enabled.filter((m) => !modelCatalog.some((n) => n.id === m.id)), ...modelCatalog];
  const isEnabled = (id) => enabled.some((m) => m.id === id);
  container.append(
    heading(
      'Models',
      badge(enabled.length + ' enabled'),
      button(catalogBusy ? 'Loading…' : 'Refresh', () => loadModels(true), '', {
        disabled: catalogBusy,
      }),
    ),
  );
  const change = (k, v) => {
    f[k] = v;
    render();
  };
  container.append(
    h(
      'div',
      { class: 'toolbar standalone' },
      input('Search models', f.search, (v) => change('search', v), {
        placeholder: 'Search models',
        type: 'text',
      }),
      select(
        'Provider',
        [
          ['', 'All providers'],
          ...[...new Set(all.map((m) => modelProvider(m)))].sort().map((n) => [n, n]),
        ],
        f.provider,
        (v) => change('provider', v),
      ),
      h(
        'label',
        { class: 'inline-check' },
        h('input', {
          type: 'checkbox',
          checked: f.enabled,
          onChange: (e) => change('enabled', e.target.checked),
        }),
        'Enabled',
      ),
    ),
  );
  if (catalogError) container.append(errorBox(catalogError));
  const models = all
    .filter(
      (m) =>
        (!f.enabled || isEnabled(m.id)) &&
        (!f.provider || modelProvider(m) === f.provider) &&
        (m.id + ' ' + m.name).toLowerCase().includes(f.search.toLowerCase()),
    )
    .sort(
      (a, b) => modelProvider(a).localeCompare(modelProvider(b)) ||
        Number(isEnabled(b.id)) - Number(isEnabled(a.id)) || a.name.localeCompare(b.name),
    );
  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ['MODEL', 'INPUT / 1M', 'OUTPUT / 1M', 'CONTEXT', 'ENABLED'].map((t) => h('th', {}, t)),
      ),
    ),
    h(
      'tbody',
      {},
      models.flatMap((m, index) => [
        index === 0 || modelProvider(models[index - 1]) !== modelProvider(m)
          ? h('tr', { class: 'provider-heading' }, h('th', { colSpan: 5, scope: 'rowgroup' },
              modelProvider(m), h('span', {}, models.filter(n => modelProvider(n) === modelProvider(m)).length + ' models')))
          : null,
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, name(m.name)), h('small', {}, m.id)),
          h('td', { class: 'mono' }, money(Number(m.pricing.prompt) * 1e6)),
          h('td', { class: 'mono' }, money(Number(m.pricing.completion) * 1e6)),
          h('td', { class: 'mono' }, m.context_length.toLocaleString()),
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              'aria-label': 'Enable ' + m.name,
              checked: isEnabled(m.id),
              onChange: async (e) => {
                e.target.disabled = true;
                try {
                  await mutate('/settings', 'PATCH', {
                    selectedModels: e.target.checked
                      ? [...state.settings.selectedModels, m]
                      : state.settings.selectedModels.filter((n) => n.id !== m.id),
                  });
                } catch (err) {
                  toast(err.message);
                  render();
                }
              },
            }),
          ),
        ),
      ]),
    ),
  );
  container.append(models.length ? h('section', { class: 'panel table-scroll' }, table) : empty('No models'));
}
function renderSettings(container) {
  if (!settingsDraft) settingsDraft = { ...state.settings, apiKey: '' };
  const f = settingsDraft;
  container.append(heading('Settings'));
  const error = h('div', {}),
    form = h('form', { class: 'settings-form' });
  function numeric(label, key, min, max, step = 1) {
    return field(
      label,
      input(label, f[key], (v) => (f[key] = Number(v)), {
        type: 'number',
        min,
        max,
        step,
        required: true,
      }),
    );
  }
  function section(title, children) {
    return h(
      'section',
      { class: 'settings-section' },
      h('h2', {}, title),
      h('div', { class: 'settings-fields' }, children),
    );
  }
  form.append(
    section('Connection', [
      badge(
        state.keyConfigured ? 'Key configured' : 'Key missing',
        state.keyConfigured ? 'completed' : 'failed',
      ),
      field(
        'API key',
        input('API key', f.apiKey, (v) => (f.apiKey = v), {
          type: 'password',
          autoComplete: 'new-password',
          placeholder: 'Replace existing key',
        }),
      ),
      button('Test connection', async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api('/key/test', 'POST', {});
          toast('Connection verified');
        } catch (e) {
          toast(e.message);
        } finally {
          render();
        }
      }),
    ]),
    section('Comparison', [
      h(
        'div',
        { class: 'fields' },
        numeric('Minimum width · px', 'minWidth', 320, 7680),
        numeric('Minimum height · px', 'minHeight', 240, 4320),
      ),
      field(
        'Columns',
        select(
          'Columns',
          Array.from({ length: 9 }, (_, i) => [i + 1, i + 1]),
          f.columns,
          (v) => (f.columns = Number(v)),
        ),
      ),
    ]),
    section('Generation', [
      h(
        'div',
        { class: 'fields' },
        numeric('Temperature', 'temperature', 0, 2, 0.1),
        numeric('Max output tokens', 'maxTokens', 256, 128000),
        numeric('Concurrency', 'concurrency', 1, 8),
        numeric('Timeout · seconds', 'timeoutSeconds', 15, state.environment === 'CLOUDFLARE' ? 1740 : 1800),
      ),
    ]),
    section('System prompt', [
      field(
        'Instructions',
        h('textarea', {
          'aria-label': 'System instructions',
          value: f.systemPrompt,
          rows: 10,
          required: true,
          onInput: (e) => (f.systemPrompt = e.target.value),
        }),
      ),
    ]),
    error,
  );
  const save = h('button', { type: 'submit', class: 'button primary' }, 'Save settings');
  form.append(h('footer', { class: 'actions' }, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const { selectedModels, apiKey, ...patch } = f;
    try {
      await mutate(
        '/settings',
        'PATCH',
        { ...patch, ...(apiKey ? { apiKey } : {}) },
        'Settings saved',
      );
      settingsDraft = null;
      render();
    } catch (e) {
      error.replaceChildren(errorBox(e.message));
      save.disabled = false;
    }
  });
  container.append(form);
  if (state.importEnabled) {
    const progress = h('span', { role: 'status' });
    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Workspace snapshot' });
    const start = button('Import snapshot', async () => {
      if (!file.files?.[0]) return;
      start.disabled = true;
      try {
        const snapshot = JSON.parse(await file.files[0].text());
        if (snapshot.format !== 1 || !Array.isArray(snapshot.runs)) throw Error('Invalid workspace snapshot');
        const send = body => api('/import', 'POST', { ...body, snapshotId: snapshot.snapshotId });
        await send({ phase: 'start', settings: snapshot.settings, prompts: snapshot.prompts,
          versions: snapshot.versions, runCount: snapshot.runs.length });
        for (let i = 0; i < snapshot.runs.length; i++) {
          progress.textContent = `${i + 1}/${snapshot.runs.length}`;
          await send({ phase: 'run', run: snapshot.runs[i] });
        }
        await send({ phase: 'finish' });
        progress.textContent = 'Import complete';
        await refresh();
        toast('Workspace imported');
      } catch (e) { progress.textContent = e.message; }
      finally { start.disabled = false; }
    });
    container.append(h('section', { class: 'panel' }, h('h2', {}, 'Migration'), file, start, progress));
  }
}
async function detail(id) {
  let run,
    tab = 'response',
    last = '',
    dialog;
  const body = h('div', {}),
    footer = h('div', { class: 'actions' });
  dialog = modal('Run ' + id.slice(0, 8), body, [footer]);
  function draw() {
    const tabs = h(
      'div',
      { class: 'tabs' },
      ['response', 'prompt', 'settings'].map((t) =>
        button(
          t,
          () => {
            tab = t;
            draw();
          },
          tab === t ? 'active' : '',
        ),
      ),
    );
    body.replaceChildren(
      h(
        'div',
        { class: 'detail-summary' },
        badge(run.status, run.status),
        h('strong', {}, runModelName(run)),
        badge('v' + run.version),
        h('code', {}, duration(run)),
        tokens(run.metrics),
        h('code', {}, money(run.metrics?.cost)),
      ),
    );
    if (run.error) body.append(errorBox(run.error));
    body.append(
      tabs,
      h(
        'pre',
        { class: 'code' },
        tab === 'prompt'
          ? run.prompt_content
          : tab === 'settings'
            ? JSON.stringify(
                {
                  ...run.config,
                  model: run.model_id,
                  resolvedModel: run.resolved_model,
                  provider: run.provider,
                  metrics: run.metrics,
                },
                null,
                2,
              )
            : run.raw || 'No response',
      ),
    );
    footer.replaceChildren(button('Close', () => dialog.close()));
    if (['running', 'queued'].includes(run.status))
      footer.prepend(
        button(
          'Cancel run',
          async () => {
            try {
              await mutate('/runs/' + id + '/cancel', 'POST', {}, 'Cancelled');
              await load();
            } catch (e) {
              toast(e.message);
            }
          },
          'danger',
        ),
      );
    if (run.html) footer.append(link('Preview ↗', '/gallery/?compare=' + id, 'primary'));
  }
  async function load() {
    try {
      const r = await api('/runs/' + id);
      if (JSON.stringify(r) !== last) {
        run = r;
        last = JSON.stringify(r);
        draw();
      }
    } catch (e) {
      body.replaceChildren(errorBox(e.message));
    }
  }
  await load();
  if (!dialog.isConnected) return;
  const timer = setInterval(load, 2000);
  dialog.addEventListener('close', () => clearInterval(timer));
}
await refresh();
setInterval(refresh, 2500);
