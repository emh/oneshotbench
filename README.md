# Oneshot

A benchmark studio for comparing one-shot web implementations across OpenRouter models. The admin and gallery are separate native JavaScript apps served directly from source, with zero third-party packages and no build step.

The hosted admin and API run on Cloudflare, protected by Cloudflare Access. Prompts, versions, settings, and run metadata live in a SQLite Durable Object; generated HTML and raw responses live in a private R2 bucket. Workflows execute model requests. GitHub Pages serves the public gallery, which reads completed results from a separate read-only Cloudflare endpoint.

- [Admin](https://oneshotbench.emh.workers.dev/)
- [Public gallery](https://emh.io/oneshotbench/)
- [Cloud deployment and migration](cloudflare/README.md)

The local Node backend remains available for offline development and independent local workspaces. Local and hosted databases do not synchronize.

## Run locally

Requires Node.js 24 or later (uses built-in SQLite).

```sh
npm run dev
```

- Admin: http://127.0.0.1:5173/
- Gallery and comparisons: http://127.0.0.1:5173/gallery/
- API: http://127.0.0.1:4310/api/state

The server reads `OPENROUTER_API_KEY` from `.env`. You can replace it and verify the connection in **Settings**. The saved key is never returned to the browser. Both servers bind to loopback only. Development serves the same app and API on ports 5173 and 4310. There is no install or build step. Refresh the browser to load frontend edits. Backend changes require a restart.

1. Open **Models**, browse the live OpenRouter catalog grouped by provider, and enable your contenders. Search, provider filters, and enabled-only filtering apply within the groups.
2. Create or edit prompts in **Prompts**. Four editable starter prompts are included; there are no fabricated results.
3. Choose **New run**, select any combination of prompts and enabled models, and choose a version for each prompt (latest by default). Submit the batch to make billable requests using your OpenRouter account. In the prompt list, the version dropdown switches the displayed title, category, content, status, and run count. **Run vN** starts a run with that version selected; **Edit latest** keeps historical versions immutable.
4. Watch results in **Runs**. Search and filter by model, prompt, or status, and sort by date. Run details include the original response, prompt, settings, provider, tokens, duration, and reported cost.
5. Select 2–9 completed results from the same prompt to compare. Different prompt versions can be compared and are labeled. Each tile has a model/result selector; layouts support 1–9 columns, including 2×2, 3×3, and a single row.

The gallery groups completed results by batch, with the submission date/time, prompt versions, and models above each batch's previews. Search and filters hide matching cards in place; selection, sorting, refresh of unchanged outputs, and returning from comparison preserve the existing preview documents and their state. Batch summaries describe all completed results in that batch, even while filters hide some of them.

## Prompt and run semantics

- A draft can be edited repeatedly without incrementing its version.
- Submitting its first run freezes the version immediately, even while the job is queued. Editing a frozen version creates a new draft version. Unchanged saves do not create a version.
- A run is one model × one prompt version. A batch is the Cartesian product of the selections, capped at 200 implementations.
- Historical versions can be run again unchanged. Only the selected version is locked; rerunning an older version leaves the latest draft editable. A run uses current generation settings unless overridden, even when using an old prompt version.
- Each result preserves its prompt text and title, requested and resolved model, output instructions, generation configuration, response, and available usage metadata. Prompt history stays accessible in the editor. Archiving a prompt keeps its runs and history intact.
- The queue defaults to two concurrent requests. Timeout, concurrency, temperature, and token limit are configurable. There are no automatic retries or provider fallbacks. A failed response can still incur charges; known usage is preserved.
- Locally, the process resumes queued jobs after a restart and marks in-flight jobs interrupted. On Cloudflare, persisted queue alarms dispatch Workflows; an attempt is claimed before each paid request, preventing automatic replay after an interrupted execution. Cancellation stops queued jobs and terminates active work, but cannot guarantee the provider stops billing immediately.
- API-reported cost can be unavailable; missing cost is shown as `—`, not estimated. Duration measures the full request, not time to first token.

## Output contract and preview isolation

Every request includes configurable system instructions asking for one complete, standalone HTML file with inline CSS/JS, embedded visuals, and no external dependencies or network access. The harness extracts raw HTML or fenced HTML. Incomplete, truncated, or non-HTML responses remain inspectable as failed runs. It does not repair outputs, rerun the model, or judge visual quality automatically.

Previews use `sandbox="allow-scripts"` without `allow-same-origin`. A restrictive Content Security Policy blocks external scripts, fetches, frames, forms, and external assets. Browser storage, popups, top navigation, and downloads are unavailable. Inline JavaScript and data-URL images work. A direct HTML endpoint also enforces the sandbox through response headers. These browser boundaries protect the host app; expensive or looping generated JavaScript can still consume browser resources.

Comparison iframes are at least **1200×900 CSS pixels** by default, configurable in Settings. That minimum applies to the iframe itself, excluding the tile header. Tiles expand to fill the screen; the canvas scrolls when the grid does not fit. Gallery thumbnails are scaled previews, while the comparison canvas renders at actual size. Display scaling can make a 5K screen expose fewer CSS pixels than physical pixels.

## Start and static gallery export

```sh
npm start
```

The local server serves the admin at http://127.0.0.1:4310/ and gallery at http://127.0.0.1:4310/gallery/.

```sh
npm run export:gallery
```

This creates `exports/gallery/`, containing the standalone gallery and a `data.json` snapshot of completed runs. It includes prompt text, generated HTML, model identities, settings captured with runs, and usage metadata. It excludes credentials, active jobs, failed results, private model selections, the database, and admin endpoints. Exported pages use relative asset URLs and query-string comparison links, suitable for a GitHub Pages subdirectory or Cloudflare static hosting. Serve this directory over HTTP rather than opening `index.html` with `file://`. Export again to update the snapshot. Nothing is deployed automatically.

## Storage and source layout

```text
apps/admin/        Admin interface
apps/gallery/      Read-only gallery and comparison canvas
apps/shared/       DOM helpers, preview sandbox, styles
server/            Local HTTP API, SQLite storage, OpenRouter queue
scripts/           Development launcher and static gallery exporter
cloudflare/        Hosted API, Access authentication, queue, R2, Workflows
tests/             Behavioral and API tests; isolated browser fixture server
data/oneshot.sqlite Persistent workspace (ignored by Git)
.env               Local OpenRouter key (ignored by Git)
```

Back up local `data/` and `.env` with the server stopped. They are separate from source and gallery exports. The local server has no authentication and should stay bound to loopback. The hosted admin requires Cloudflare Access, including JWT validation in the Worker.

## Dependencies

Zero third-party packages: no runtime, build, or test dependencies. Node.js 24 built-ins provide local HTTP, SQLite, filesystem operations, deployment, and testing. The hosted backend uses Cloudflare platform APIs. Browser UI uses native ES modules, DOM APIs, system fonts, and local CSS. No fonts, scripts, images, analytics, or other assets load from a CDN. OpenRouter is called only by the backend. Generated previews remain subject to the restrictive CSP.

## Verification

```sh
npm test
```

Tests use isolated databases and mocked model responses; they do not spend OpenRouter credits. They cover prompt immutability, transaction rollback, historical preservation, interrupted-run recovery, generation capture, truncation, concurrency, cancellation, credential redaction, API validation, preview policy, and export boundaries.

`node tests/fixture-server.mjs` serves a disposable browser-test workspace on http://127.0.0.1:4311 with thirteen clearly labeled mock implementations across two batches and two providers. Each preview body exposes a unique `data-instance` marker for checking document lifetime while filtering and selecting. It never calls OpenRouter and never modifies the real workspace. Stop it with Ctrl+C.

OpenRouter integration follows the [chat completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) and [live model catalog](https://openrouter.ai/docs/guides/overview/models).
