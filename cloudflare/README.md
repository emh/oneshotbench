# Cloud hosting

The application source runs as native modules. There is no package install, bundling, transpilation, or build command. Deployment uploads source modules unchanged; gallery preparation only copies files and sets the API URL.

## Services

| Service | Responsibility |
| --- | --- |
| `oneshotbench` Worker | Admin assets and authenticated API |
| `Workspace` SQLite Durable Object | One persistent workspace: prompts, immutable versions, settings, metadata, queue, attempt claims |
| `oneshotbench-runs` Workflow | One execution per run, without automatic paid retries |
| `oneshotbench-outputs` private R2 bucket | HTML and raw model responses keyed by run ID |
| `oneshotbench-gallery` Worker | Public `GET /api/gallery` only |
| GitHub Pages, `gh-pages` branch | Static gallery and comparisons |

Cloudflare Access protects the entire admin hostname. The Worker also checks the JWT signature, issuer, audience, and expiry. Configure an Allow policy for the owner's email; no public bypass policy is needed because the gallery API has its own hostname. Preview deployment URLs are disabled.

The public gallery includes every completed run, its prompt, captured generation configuration, HTML, model identity, and usage metadata. The prompt directory exposes all prompts and versions, including unused drafts and archived prompts. Chart metadata includes model, prompt/version, reasoning effort, batch, status, date, and metrics for all runs, including failed and active attempts; it excludes their outputs, errors, and generation settings. Raw responses, credentials, and private settings are excluded. The gallery requests `/api/gallery?metadata=1` first, which performs no R2 reads. `/api/gallery?run=ID` returns only the HTML of a completed run; failed, active, deleted, and missing runs cannot be fetched through it. The existing unparameterized snapshot remains compatible with older clients. The R2 bucket itself is not public. CORS permits the configured GitHub Pages origin; the gallery data is intentionally public independently of CORS.

The initial OpenRouter key is a Worker secret. Replacing it through Settings stores an AES-GCM encrypted override in the workspace, using the separate `KEY_ENCRYPTION_SECRET` Worker secret. Neither key is returned by the API. Preserve the encryption secret across deployments.

## Deploy

Requires Node.js 24 and a Cloudflare API token in `CLOUDFLARE_API_TOKEN`, or an existing Wrangler OAuth login. The native deployment helper can refresh an existing OAuth session; Wrangler is not a project dependency.

1. Copy `cloudflare/config.example.json` to ignored `cloudflare/config.json`. Set account/resource names, admin and public API URLs, Access issuer/audience, and gallery URL/origin.
2. Create a self-hosted Access application for the entire admin hostname with an owner-only Allow policy. Copy its audience and team issuer into the config.
3. On first deployment, set `KEY_ENCRYPTION_SECRET` to a random string of at least 32 characters in an ignored `.env.cloudflare`. Keep this file private. Existing `.env` supplies `OPENROUTER_API_KEY`.
4. Review and upload:

```sh
npm run cloudflare:deploy
node --env-file=.env --env-file=.env.cloudflare scripts/cloudflare-deploy.mjs --apply
```

The default is a dry run. `--apply` creates resources as needed and uploads modules. Later deployments preserve existing secrets when secret environment variables are omitted:

```sh
node scripts/cloudflare-deploy.mjs --apply
```

For workers.dev hosting, the script enables each configured Worker subdomain. Custom domains, if used, must be attached in Cloudflare. Keep `ALLOW_IMPORT` false except during a migration. Set `PUBLIC_GALLERY` true to expose completed results.

Cloudflare can defer updates to an active Durable Object for up to five minutes. Verify the hosted Settings page after this window when changing migration flags or gallery configuration. See [Durable Objects code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/).

## Import a local workspace

Stop creating local runs before taking a snapshot. The exporter opens SQLite read-only and captures a consistent transaction. It does not include `.env` or credentials.

```sh
npm run cloudflare:snapshot
```

Set `ALLOW_IMPORT` true and deploy. Sign in to the hosted admin, open Settings → Migration, and select `data/cloudflare-snapshot.json`. Import into an empty cloud workspace. Import is resumable using the same snapshot: existing rows are skipped, and normal admin writes are blocked until all runs are present. Active local jobs become interrupted and are never replayed. After successful import, set `ALLOW_IMPORT` false and redeploy. Preserve the local database and snapshot as migration backups; they do not track subsequent hosted changes.

For automated import with an existing Access service-token policy, `scripts/cloudflare-import.mjs` accepts `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the environment. These are not required for the browser import.

## Publish the gallery

```sh
npm run gallery:prepare
```

Publish only `exports/pages/` at the root of the `gh-pages` branch. Configure GitHub Pages to serve that branch's root. `.nojekyll` prevents Jekyll processing. There is no compilation step and no model output or credentials in the published files. Results are fetched live from `publicApiOrigin`; refresh the gallery to load new results without republishing its static assets.

## Execution and recovery

Queue alarms persist and honor configured concurrency. Each Workflow claims its run before calling OpenRouter. Interrupted attempts are not automatically repeated, even if an artifact write fails, to avoid duplicate spending. Such runs may need a new manually initiated run. Provider fallbacks are disabled. The hosted request timeout is capped at 1,740 seconds (29 minutes), leaving time to save results within the Workflow step's 30-minute timeout.

`npm test` uses native SQLite and mocked Cloudflare bindings/model responses. Tests cover migration preservation, queue recovery, duplicate request prevention, Access JWTs, encrypted credentials, public route isolation, and source module completeness. Tests do not spend OpenRouter credits. Local tests do not substitute for a real hosted model run.

The local SQLite backup is independent of Cloudflare storage. Protect the R2 bucket, Durable Object namespace, and encryption secret together when managing hosted backups or recovery; deleting these resources destroys their corresponding data.
