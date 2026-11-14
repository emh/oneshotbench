import { OUTPUT_INSTRUCTIONS, HARNESS_VERSION } from './format.mjs';
import { variants } from './reasoning.mjs';

export const defaults = {
  minWidth: 1200,
  minHeight: 900,
  columns: 2,
  concurrency: 2,
  temperature: 0.7,
  maxTokens: 16000,
  timeoutSeconds: 300,
  systemPrompt: OUTPUT_INSTRUCTIONS,
  selectedModels: [],
};
export class StoreCore {
  constructor(db, { seed = true } = {}) {
    this.db = db;
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id), version INTEGER NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL, locked_at TEXT, updated_at TEXT NOT NULL, UNIQUE(prompt_id,version));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES versions(id), model_id TEXT NOT NULL, model_name TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, status TEXT NOT NULL, config TEXT NOT NULL, html TEXT, raw TEXT, error TEXT, metrics TEXT, provider TEXT, response_id TEXT, finish_reason TEXT, resolved_model TEXT);
      CREATE INDEX IF NOT EXISTS runs_date ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_version ON runs(version_id);
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1,?)').run(JSON.stringify(defaults));
    if (seed && !this.db.prepare('SELECT id FROM prompts LIMIT 1').get()) {
      for (const p of [
        [
          'SaaS analytics dashboard',
          'Dashboard',
          'Build a beautiful analytics dashboard for a fictional SaaS product called Orbit. Include revenue and active-user metrics, an interactive revenue chart with time-range controls, a recent transactions table, and a sidebar. Use realistic sample data. Make filtering and navigation functional. Design it to feel like a carefully crafted modern product.',
        ],
        [
          'Creative studio landing page',
          'Website',
          'Create a distinctive portfolio website for Forma, an independent design studio. Include an editorial hero, a grid of four case studies, services, a short about section, and a contact form with client-side validation. Use typography, layout, and CSS-generated visuals to give the studio a memorable identity.',
        ],
        [
          'Personal task manager',
          'Application',
          'Build a polished personal task manager with a sidebar for Today, Upcoming, and Completed. Include sample tasks, adding tasks, marking them complete, priority labels, due dates, text search, and filtering. Keep all state in memory. Make the interactions satisfying and the layout easy to scan.',
        ],
        [
          'Interactive solar system',
          'Creative',
          'Build an interactive educational solar system explorer. Show the eight planets orbiting the sun using CSS or canvas. Let users pause motion, change orbital speed, and select a planet to see its facts in a detail panel. Include keyboard-accessible controls and a thoughtful dark visual design.',
        ],
      ])
        this.createPrompt({ title: p[0], category: p[1], content: p[2] });
    }
  }
  settings() {
    return {
      ...defaults,
      ...JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value),
    };
  }
  saveSettings(patch) {
    const value = { ...this.settings(), ...patch };
    this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(value));
    return value;
  }
  transaction(fn) {
    if (this.db.transactionSync) return this.db.transactionSync(fn);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  createPrompt({ title, category, content }) {
    return this.transaction(() => {
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      this.db.prepare('INSERT INTO prompts (id,created_at) VALUES (?,?)').run(id, now);
      this.db
        .prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,NULL,?)')
        .run(crypto.randomUUID(), id, 1, title, category, content, now);
      return this.prompt(id);
    });
  }
  prompt(id) {
    return this.prompts(true).find((p) => p.id === id);
  }
  prompts(includeArchived = false) {
    const rows = this.db
      .prepare(
        `SELECT p.id,p.archived,p.created_at,v.id AS version_id,v.version,v.title,v.category,v.content,v.locked_at,v.updated_at,
      (SELECT COUNT(*) FROM runs r JOIN versions rv ON r.version_id=rv.id WHERE rv.prompt_id=p.id) AS run_count
      FROM prompts p JOIN versions v ON v.prompt_id=p.id WHERE v.version=(SELECT MAX(version) FROM versions WHERE prompt_id=p.id) ${includeArchived ? '' : 'AND p.archived=0'} ORDER BY p.created_at ASC`,
      )
      .all();
    return rows.map((row) => ({
      ...row,
      versions: this.db
        .prepare('SELECT * FROM versions WHERE prompt_id=? ORDER BY version DESC')
        .all(row.id),
    }));
  }
  editPrompt(id, { title, category, content, baseVersionId }) {
    return this.transaction(() => {
      const current = this.prompt(id);
      if (!current) throw Object.assign(new Error('Prompt not found'), { status: 404 });
      if (baseVersionId !== current.version_id)
        throw Object.assign(
          new Error('This prompt has a newer version. Reopen it before saving.'),
          { status: 409 },
        );
      if (title === current.title && category === current.category && content === current.content)
        return current;
      const now = new Date().toISOString();
      if (current.locked_at)
        this.db
          .prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,NULL,?)')
          .run(crypto.randomUUID(), id, current.version + 1, title, category, content, now);
      else
        this.db
          .prepare('UPDATE versions SET title=?,category=?,content=?,updated_at=? WHERE id=?')
          .run(title, category, content, now, current.version_id);
      return this.prompt(id);
    });
  }
  archivePrompt(id, archived) {
    return this.db.prepare('UPDATE prompts SET archived=? WHERE id=?').run(archived ? 1 : 0, id);
  }
  enqueue(promptIds, modelIds, overrides = {}, promptVersions = {}) {
    const choices = variants(modelIds);
    if (promptIds.length * choices.length > 200)
      throw Object.assign(new Error('A batch can include at most 200 implementations.'), { status: 400 });
    if (!promptVersions || typeof promptVersions !== 'object' || Array.isArray(promptVersions) ||
      Object.entries(promptVersions).some(([id, version]) => !promptIds.includes(id) || typeof version !== 'string' || !version))
      throw Object.assign(new Error('Choose a valid version for each selected prompt.'), { status: 400 });
    return this.transaction(() => {
      const settings = this.settings(),
        batchId = crypto.randomUUID(),
        now = new Date().toISOString();
      const models = choices.map(choice => {
        const model = settings.selectedModels.find(m => m.id === choice.modelId);
        return model ? { ...model, reasoningEffort: choice.reasoningEffort } : null;
      });
      const prompts = promptIds.map((id) => {
        const prompt = this.prompt(id);
        if (!prompt || !Object.hasOwn(promptVersions, id)) return prompt;
        const version = prompt.versions.find(v => v.id === promptVersions[id]);
        if (!version) throw Object.assign(new Error('The selected version does not belong to this prompt.'), { status: 400 });
        return { ...prompt, version_id: version.id };
      });
      if (models.some((m) => !m) || prompts.some((p) => !p || p.archived))
        throw Object.assign(new Error('Choose available prompts and enabled models.'), {
          status: 400,
        });
      const config = {
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        timeoutSeconds: settings.timeoutSeconds,
        systemPrompt: settings.systemPrompt,
        previewMinWidth: settings.minWidth,
        previewMinHeight: settings.minHeight,
        harnessVersion: HARNESS_VERSION,
        ...overrides,
      };
      const ids = [];
      for (const p of prompts) {
        this.db
          .prepare('UPDATE versions SET locked_at=COALESCE(locked_at,?) WHERE id=?')
          .run(now, p.version_id);
        for (const model of models) {
          const id = crypto.randomUUID();
          ids.push(id);
          this.db
            .prepare(
              'INSERT INTO runs (id,batch_id,version_id,model_id,model_name,created_at,status,config) VALUES (?,?,?,?,?,?,?,?)',
            )
            .run(
              id,
              batchId,
              p.version_id,
              model.id,
              model.name,
              now,
              'queued',
              JSON.stringify({ ...config, ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}) }),
            );
        }
      }
      return { batchId, ids };
    });
  }
  runs({ details = false, completed = false } = {}) {
    const fields = details
      ? 'r.*'
      : 'r.id,r.batch_id,r.version_id,r.model_id,r.model_name,r.created_at,r.started_at,r.finished_at,r.status,r.config,r.error,r.metrics,r.provider,r.response_id,r.finish_reason,r.resolved_model';
    return this.db
      .prepare(
        `SELECT ${fields},v.prompt_id,v.version,v.title AS prompt_title,v.category${details ? ',v.content AS prompt_content' : ''} FROM runs r JOIN versions v ON v.id=r.version_id ${completed ? "WHERE r.status='completed'" : ''} ORDER BY r.created_at DESC,r.rowid DESC`,
      )
      .all()
      .map((row) => this.decodeRun(row));
  }
  decodeRun(row) {
    return row
      ? {
          ...row,
          config: JSON.parse(row.config),
          metrics: row.metrics ? JSON.parse(row.metrics) : null,
        }
      : undefined;
  }
  run(id) {
    return this.decodeRun(
      this.db
        .prepare(
          'SELECT r.*,v.prompt_id,v.version,v.title AS prompt_title,v.category,v.content AS prompt_content FROM runs r JOIN versions v ON v.id=r.version_id WHERE r.id=?',
        )
        .get(id),
    );
  }
  updateRun(id, patch) {
    const allowed = [
      'status',
      'started_at',
      'finished_at',
      'html',
      'raw',
      'error',
      'metrics',
      'provider',
      'response_id',
      'finish_reason',
      'resolved_model',
    ];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (entries.length)
      this.db
        .prepare(`UPDATE runs SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
        .run(...entries.map(([key, val]) => (key === 'metrics' ? JSON.stringify(val) : val)), id);
  }
  deleteRuns(ids, beforeDelete = () => {}) {
    return this.transaction(() => {
      const runs = ids.map(id => this.run(id)).filter(Boolean);
      beforeDelete(runs);
      for (const run of runs) this.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
      return runs.map(run => run.id);
    });
  }
  recover() {
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='The server stopped during this request. It was not automatically retried to avoid duplicate charges.',finished_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
  }
  close() {
    this.db.close();
  }
}
