# Development guide

How to run, test and work on SmartOps Agent locally. The project overview is in the
[README](../README.md); the list of documents is in [docs/README.md](README.md).

## Repository layout

```
apps/
  api/            Express 5 + TypeScript (ESM) — webhook, queue, AI, catalog, internal API
  admin/          Next.js 15 admin panel (noindex)
n8n/workflows/    Exported n8n workflows (no credentials)
docker/postgres/  Postgres init scripts for local dev
docs/adr/         Architecture Decision Records
docker-compose.yml  Local infra: Postgres 17 + n8n
```

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 12 (`corepack enable` picks the version from `packageManager`)
- Docker Desktop (Compose v2)

## Setup

```bash
# 1. Dependencies (single lockfile at the root)
pnpm install

# 2. Environment
cp .env.example .env                        # docker-compose (Postgres + n8n)
cp apps/api/.env.example apps/api/.env      # API
cp apps/admin/.env.example apps/admin/.env.local
#    Replace every "change-me". Generate N8N_ENCRYPTION_KEY once and never change it:
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    DATABASE_URL in apps/api/.env must use POSTGRES_USER / POSTGRES_PASSWORD.

# 3. Local infrastructure
docker compose up -d
docker compose ps        # postgres and n8n should become "healthy"

# 4. Database schema (Prisma migrations)
pnpm --filter @smartops/api db:migrate

# 5. Apps
pnpm dev                 # api on http://localhost:4000 + api worker, admin on http://localhost:3000
curl http://localhost:4000/api/v1/health   # {"status":"ok","db":"up",...}
```

n8n UI: http://localhost:5678 (create the owner account on first visit).
Postgres: `localhost:5432`, databases `smartops` (app) and `n8n` (n8n).
Both ports are published on `127.0.0.1` only.

### ⚠️ The Postgres init script only runs on a fresh volume

`docker/postgres/init/01-create-n8n-db.sh` creates the `n8n` role and database.
The official Postgres image runs scripts in `/docker-entrypoint-initdb.d`
**only when the data volume is created for the first time**. If the volume
already exists, changes to the script, or to `N8N_DB_*` / `POSTGRES_*` in `.env`,
are **ignored**.

To apply them you must recreate the volume, which **deletes all local data**
(app database and n8n workflows/credentials; export workflows first):

```bash
docker compose down -v   # destructive: removes postgres_data and n8n_data
docker compose up -d
```

Alternatively, create the role/database manually with `psql` on the existing volume.

## Development without Meta

The whole project can be run and tested **without a Meta / WhatsApp Business
account**: no app, no WABA, no phone number, no tunnel. A local simulator takes the
place of Meta in both directions, using the same payload formats, the same
`X-Hub-Signature-256` signature and the same Graph API paths and error shapes. The
production code does not change: it is only pointed at another URL.

| Tool                      | Replaces                                                                                                         | What it does                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wa:simulate`             | Meta → API (webhooks)                                                                                            | Sends **signed** webhooks to the local API: text, image, document, audio, interactive replies, delivery statuses (incl. `failed` with a Meta error code) and stored fixtures |
| `wa:fake-graph` (`:4010`) | API → Meta (Graph API)                                                                                           | Serves media (metadata + short-lived download URL), accepts outbound messages and sends back signed `sent → delivered → read` (or `failed`) status webhooks                  |
| `wa:media:retry`          | Re-enqueues `failed` media downloads (`--all-failed` or `--id <mediaFileId>`)                                    |
| `wa:send`                 | Queues an outbound message: `text` (24h window) or `template` (opt-in; `--opt-in-confirmed` for tests), `--wait` |
| `wa:transcription:retry`  | Re-enqueues `failed` transcriptions (`--all-failed` or `--id <mediaFileId>`)                                     |
| `wa:fixtures:capture`     | Turns stored real webhooks into anonymized fixtures (`--event <webhookEventId>=<name>`)                          |

Setup (once), in `apps/api/.env`:

```bash
# Any values work locally — they only need to be consistent between the API and the simulator.
WHATSAPP_PHONE_NUMBER_ID=100000000000001
WHATSAPP_WABA_ID=200000000000002
WHATSAPP_ACCESS_TOKEN=local-simulator-token-000000
WHATSAPP_APP_SECRET=local-simulator-app-secret-000
WHATSAPP_VERIFY_TOKEN=local-simulator-verify-token-000
WHATSAPP_GRAPH_BASE_URL=http://localhost:4010
```

Run it (three terminals):

```bash
pnpm dev                                     # API + worker (+ admin)
pnpm --filter @smartops/api wa:fake-graph    # fake Graph API on http://localhost:4010

# Simulate traffic
pnpm --filter @smartops/api wa:simulate text --text "Lista: tornillo 6mm $12"
pnpm --filter @smartops/api wa:simulate document --file ./lista.pdf --caption "Lista septiembre"
pnpm --filter @smartops/api wa:simulate audio --file ./nota.ogg
pnpm --filter @smartops/api wa:simulate text --text "hola" --bsuid-only --username ferreteria.sur
pnpm --filter @smartops/api wa:simulate text --text "hola" --duplicate    # dedupe check
pnpm --filter @smartops/api wa:simulate status --wamid <wamid> --status failed --code 131030
pnpm --filter @smartops/api wa:simulate fixture message-image             # any file in test/fixtures/whatsapp
pnpm --filter @smartops/api wa:simulate echo --to 59899000111 --text "Te atiendo yo"  # coexistence echo (phase 7)
pnpm --filter @smartops/api wa:simulate echo --to 59899000111 --revoke <wamid>
pnpm --filter @smartops/api wa:simulate help
```

Failure scenarios for the fake Graph API (to exercise retries and error handling), all
as `pnpm --filter @smartops/api wa:fake-graph <flags>`:

```bash
wa:fake-graph --fail-send 131030                   # every outbound message fails with that Meta code
wa:fake-graph --outside-window                     # free-form text fails with 131047; templates pass
wa:fake-graph --fault media-info:404 --fault download:500 --fault send:401
wa:fake-graph --latency 2000 --status-delay 5000   # slow API / slow deliveries
```

Media flow: `wa:simulate document --file ./lista.pdf` → the worker stores the message
and enqueues the download → it calls the fake Graph API (metadata + download URL) →
verifies SHA-256 and magic bytes → stores the bytes in `media_blobs` (ADR-008). Check it
in Prisma Studio (`media_files.status = stored`). Add `--fault download:corrupt`,
`--fault media-info:404` or `--fault download:500` to `wa:fake-graph` to see the
retry / failure paths; `wa:media:retry --all-failed` re-enqueues failed downloads.

Voice notes: `wa:simulate audio --file ./nota.ogg --transcript "El tornillo de 6mm sube a
14 pesos"` → media stored → transcription job → `messages.transcript`. With
`TRANSCRIPTION_PROVIDER=fake` the expected text is returned; with `groq` the real audio is
transcribed (free plan). AAC/AMR audio is skipped (`unsupported_format`).

Outbound flow: `wa:simulate text` (the contact writes → 24h window + implicit opt-in) →
`wa:send text --to 59899000111 --text "Recibimos tu lista" --wait` → the worker sends
it through the fake Graph API → signed status webhooks → `sent → delivered → read`.
Templates: `wa:send template --to 59899000222 --name hello_world --lang en_US
--opt-in-confirmed --wait`. Unknown templates fail with 132001
(`wa:fake-graph --templates hello_world,price_alert` to approve more); `--outside-window`
makes Meta reject free-form text with 131047.

Notes:

- Media files registered by `wa:simulate` are stored in `apps/api/.sim/media`
  (gitignored) and served from there by `wa:fake-graph`.
- `WHATSAPP_GRAPH_BASE_URL` must be `https://graph.facebook.com` in production: the
  API refuses to start otherwise, so the fake can never be used on Render.
- The simulator follows Meta's documentation, not Meta itself. Before going live,
  validate the WhatsApp flow end to end with a real Meta account.
- It covers the WhatsApp side only. Other providers (Claude, speech-to-text) need
  their own keys or test doubles, added in their phases.

## Panel login (phase 8)

1. Create the first admin **from the server** (there is no default password and no signup):

   ```bash
   pnpm --filter @smartops/api users create --email ana@example.com --name "Ana" --role admin
   # the password is asked twice, hidden (min. 15 characters; a passphrase is ideal)
   ```

2. `pnpm dev` at the root runs the API, the worker and the panel. Open
   http://localhost:3000 → login. The panel calls `/api/v1` on its own origin (Next rewrites
   it to `API_PROXY_TARGET`, default `http://localhost:4000`), so the refresh cookie is
   first-party with `SameSite=Strict` — the same setup as the demo deploy (Caddy on one VM).
3. Other user tasks: `users list | reset-password | unlock | set-role | deactivate`.

Security details (rotation and reuse detection, CSRF, lockout, roles, deploy modes):
[ADR-018](adr/ADR-018-panel-auth.md).

## Panel (phase 9, languages since phase 13)

Mobile first (bottom bar on phones, sidebar from tablets), WCAG 2.1 AA (axe in the E2E), in
**English and Spanish** (next-intl, ADR-024): the language comes from the person's choice
(saved in their profile), else `PANEL_DEFAULT_LOCALE`, else the browser; numbers and dates
follow it (en-US / es-UY). Screens: **Home** (dashboard), **Reviews** (one resolver per kind,
including the spreadsheet price-column picker), **Conversations** (🤖 bot / 👤 person /
⛔ opted out, pause / resume, reply as a person, opt-out / opt-in, chat media), **Catalog**
(price history chart), **Alerts**, **Rules** (no-code settings, business hours, global bot
switch, language of WhatsApp messages) and **Users** (admins). Every visible text lives in
`apps/admin/src/i18n/messages/{en,es}.json`; ESLint refuses literal strings in the JSX.

- Real time: Postgres triggers → ONE `LISTEN` connection per API process → SSE
  (`/api/v1/events`, [ADR-020](adr/ADR-020-panel-real-time.md)).
- Chat media is fetched with the session and shown from `blob:` URLs — no token in URLs
  ([ADR-019](adr/ADR-019-panel-media-auth.md)).
- WhatsApp digests to the team end with `PANEL_PUBLIC_URL/d/<token>` (login required, the
  token is random and the URL carries no content).
- Browser E2E (Chromium desktop, Pixel 7, iPhone 15 / WebKit): `pnpm --filter @smartops/admin e2e`
  (own `*_e2e_demo` database, API in DEMO_MODE on :4100, the real worker, an n8n stand-in,
  a production build of the panel on :3100). The suite runs in English; `i18n-es.spec.ts` runs
  the main screens in Spanish with axe. `SCREENS=1` also takes screenshots.

## Public demo (DEMO_MODE)

A $0 public demo with no WhatsApp account and no AI spend
([ADR-021](adr/ADR-021-public-demo-mode.md)):

1. Create and seed the demo database (name must end in `_demo`):
   `DEMO_DATABASE_URL=…/smartops_demo pnpm --filter @smartops/api demo:seed`.
2. Run the API **and** the worker with `DATABASE_URL=<the demo database>` and `DEMO_MODE=true`
   (n8n with the published workflows orchestrates, as in production).
3. Open the panel: the login screen shows the public demo operator; the "Try the system"
   page sends a photo, a PDF, a voice note, a known and a new spreadsheet and a prompt
   injection through the real pipeline, live.

DEMO_MODE forces the fake LLM (recorded outputs in `apps/api/demo/golden`), the fake
transcriber and the demo's own Graph API (the Graph client refuses Meta hosts — tested), and
refuses any database that is not `*_demo`. Data resets every `DEMO_RESET_INTERVAL_MINUTES`
(and with "Reset demo", at most once per 10 minutes for everyone); users and sessions are kept.

The demo CONTENT (suppliers, products, customers, sample files) comes in English or Spanish, one per
deployment: `DEMO_CONTENT_LANGUAGE=en|es` (default `en`; [ADR-031](adr/ADR-031-content-and-business-language.md)).
The English recordings were made with `pnpm --filter @smartops/api ai:record-golden --lang en`.

## Coexistence & opt-out (phase 7)

- **Human takeover (ADR-016):** a human reply — from the panel or, on a real coexistence
  number, from the WhatsApp Business app — pauses only automatic replies to that contact
  (`Message.purpose`); list processing, the catalog and team notifications never pause.
  `pnpm --filter @smartops/api wa:conversation status|pause|resume` and
  `wa:reply --to <phone> --text "…" --by <name>` stand in for the panel until phase 9.
- **Coexistence with the WhatsApp Business app** needs a real number already in the app and
  Embedded Signup run by a Solution Partner / Tech Provider — our Meta test number cannot
  exercise it. `wa:simulate echo` + doc-based fixtures test the wire format instead. See
  [docs/coexistence-client-guide.md](coexistence-client-guide.md) for the two paths
  (dedicated API number vs. real coexistence) and their costs for an actual client.
- **Opt-out (ADR-017):** deterministic keyword/phrase detection (no LLM), independent of
  the ADR-009 opt-in. `pnpm --filter @smartops/api wa:optout status|out|in --reason "…"
--by <name>` for manual/off-WhatsApp requests. An opted-out supplier's price lists are
  still ingested and update the catalog — only the acknowledgement is skipped.

## Orchestration with n8n (phase 6)

The backend decides; n8n only orchestrates (ADR-015). Four workflows live in
`n8n/workflows/`: the receiver (webhook `smartops-message-ready` → classify → route), the
processor (extract → ingest), the notifier (notifications → supplier ack) and the error
workflow (→ critical alert). Their names in n8n are still Spanish ("SmartOps · Receptor"…);
the public demo does not run n8n (it uses the light in-process orchestrator, ADR-025), so they stay
Spanish until a full-profile deployment imports them. Import, credentials and publishing:
[docs/n8n-setup.md](n8n-setup.md).

- **Outbox:** every inbound message ready for processing writes a `message.ready` event
  (`integration_events`) in the same transaction, delivered to n8n with
  `X-SmartOps-Secret`. Retries go from 30 s up to 1 h for about 24 h, then `failed` + a
  critical alert. Resend with `pnpm --filter @smartops/api n8n:replay`. Events wait while
  `N8N_DELIVERY_ENABLED=false`.
- **Pre-filter without AI:** greetings, stickers, reactions, customers' messages and long
  voice notes never reach Claude (`ingestion_runs.prefilter_rule`).
- **Notifications:** only actionable events. They go to the panel always and, as one
  WhatsApp digest per window, to `notifications.whatsappRecipients` (Settings, stored in the
  DB — never commit real numbers), with an hourly cap. Every text sent over WhatsApp follows the
  `business.language` setting (Spanish by default; ADR-024 amendment).
- **Export:** `pnpm --filter @smartops/api n8n:export` writes sanitized workflows (no
  pinned data, no secrets, credentials only by name). Then run Prettier and the static
  tests (`test -- n8n-workflows`).
- **Security:** the n8n editor must never be publicly exposed. n8n never touches the
  database.

Validated end to end on 2026-09-26:

- **Real Claude pass:** 7 scenarios for $0.0655 in total.
- **Real WhatsApp digest:** delivered to a phone.
- **Resilience:** n8n stopped and restarted. Every message was delivered once, with one run
  each.

## README media (phase 13)

The screenshots and the demo GIF in `docs/media/` are produced from the real panel on a fresh
E2E database, never edited by hand:

```bash
cd apps/admin
MEDIA=1 pnpm e2e media.spec.ts --project desktop --project iphone -g "screenshots"
MEDIA=1 MEDIA_CAPTIONS=1 pnpm e2e media.spec.ts --project desktop -g "demo video"   # GIF source
MEDIA=1 MEDIA_CAPTIONS=0 pnpm e2e media.spec.ts --project desktop -g "demo video"   # clean video + .srt
cd ../..
scripts/media/build-media.sh [kit folder]   # ffmpeg in a pinned container

# The panel guide (docs/guide), one language per run, then only its screenshots:
MEDIA=1 MEDIA_GUIDE=en pnpm --filter @smartops/admin e2e media.spec.ts --project desktop -g "guide"
MEDIA=1 MEDIA_GUIDE=es pnpm --filter @smartops/admin e2e media.spec.ts --project desktop -g "guide"
scripts/media/build-media.sh --guide
```

The captions (English on the GIF, English and Spanish subtitles for the video) are in
`apps/admin/e2e/media-captions.ts`. The MP4 and its `.en.srt` / `.es.srt` go to the portfolio
kit folder outside the repository (default `../smartops-portfolio-kit/video`). A test keeps the
README media at 8 MB at most, the Spanish guide's screenshots at 4 MB, and all media together at
12 MB.

## Scripts (root)

| Script              | What it does                            |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Runs every app in watch mode (parallel) |
| `pnpm build`        | Builds every app                        |
| `pnpm lint`         | ESLint in every app                     |
| `pnpm typecheck`    | `tsc --noEmit` in every app             |
| `pnpm test`         | Vitest (API and panel)                  |
| `pnpm format`       | Prettier write                          |
| `pnpm format:check` | Prettier check                          |

Per app: `pnpm --filter @smartops/api <script>` / `pnpm --filter @smartops/admin <script>`.

Browser E2E (Playwright, phase 9): `pnpm --filter @smartops/admin e2e` — desktop Chromium, Pixel 7 and iPhone (WebKit), with axe accessibility checks. It seeds its own `<dev db>_e2e_demo` database and starts its own API (:4100) and a production build of the panel (:3100), so it never touches your running `pnpm dev`. First time: `pnpm --filter @smartops/admin exec playwright install chromium webkit`.

API processes (run with `pnpm --filter @smartops/api <script>`):

| Script               | What it does                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                | HTTP server + worker in watch mode (`dev:api` and `dev:worker`)                                                                                             |
| `start`              | HTTP server from `dist/` (webhooks, API)                                                                                                                    |
| `start:worker`       | Worker from `dist/` (pg-boss: webhook processing, dead letters, sweeper)                                                                                    |
| `wa:subscribe`       | Subscribes the Meta app to the WABA webhooks (idempotent)                                                                                                   |
| `wa:simulate`        | Sends signed WhatsApp webhooks to the local API (see Development without Meta)                                                                              |
| `wa:fake-graph`      | Local fake Meta Graph API on :4010 (see Development without Meta)                                                                                           |
| `n8n:replay`         | Re-sends `failed` message.ready events to n8n (after fixing the cause)                                                                                      |
| `wa:conversation`    | Bot / human mode of a chat: `status`, `pause`, `resume` (stands in for the panel)                                                                           |
| `wa:reply`           | A person replies to a contact (24 h window) and takes over the conversation (phase 7)                                                                       |
| `wa:optout`          | Manual opt-in / opt-out of a contact, requires `--reason` (phase 7, ADR-017)                                                                                |
| `users`              | Panel users: `create` (first admin), `list`, `reset-password`, `unlock`, `set-role`, `deactivate` — passwords prompted hidden, never as arguments (phase 8) |
| `demo:seed`          | Wipes and refills the DEMO database (`DEMO_DATABASE_URL`, name must end in `_demo`) with 90 days of realistic activity (phase 9)                            |
| `claude-md:baseline` | Raises the size floor of the CLAUDE.md guard test after intentional growth                                                                                  |
| `n8n:export`         | Exports the SmartOps workflows from local n8n, sanitized, to n8n/workflows                                                                                  |

Tests: `pnpm --filter @smartops/api test`. Integration tests (`test/integration`) run
against a real Postgres when `TEST_DATABASE_URL` is set in `apps/api/.env` (database
name must end in `_test`; created and migrated automatically), otherwise they are skipped.

Database (API, run with `pnpm --filter @smartops/api <script>`):

| Script        | What it does                                                         |
| ------------- | -------------------------------------------------------------------- |
| `db:generate` | Generates the Prisma client into `src/generated/prisma` (gitignored) |
| `db:migrate`  | `prisma migrate dev` — creates/applies migrations (local only)       |
| `db:deploy`   | `prisma migrate deploy` — applies versioned migrations (release)     |
| `db:status`   | Shows pending migrations                                             |
| `db:studio`   | Prisma Studio                                                        |

`build`, `typecheck` and `test` run `prisma generate` first.

## CI/CD (phase 11)

Details, timings, budget and the GitHub settings checklist: [docs/ci-cd.md](ci-cd.md)
(decision: [ADR-022](adr/ADR-022-ci-cd.md)).

- **CI** (`.github/workflows/ci.yml`): every push runs `quick` (workflow lint, gitleaks on
  new commits, dependency audit gate, format, lint, typecheck, fast tests). Pull requests to
  `main`, manual runs and a nightly run add the coverage gate against a real Postgres, the
  build, the Playwright E2E (per the `E2E_POLICY` variable) and the Docker image checks.
- **Releases** (`release.yml`): release-please keeps a release PR; merging it tags
  `vX.Y.Z` and publishes the API and panel images (amd64 + arm64) to GHCR, each checked
  before the push. Changelog: [CHANGELOG.md](../CHANGELOG.md). Nothing is deployed yet.
- **Security** (`security.yml`): weekly full-history secret scan + audit. Policy:
  [SECURITY.md](../SECURITY.md).
- **Local guard**: `pnpm hooks:install` once per clone — the pre-push hook refuses a direct
  push to `main` (changes land through pull requests).
- **Docker**: `docker build -f apps/api/Dockerfile -t smartops-api .` and
  `docker build -f apps/admin/Dockerfile -t smartops-admin .` from the repository root.

## API conventions

- All routes under `/api/v1/`. Health: `GET /api/v1/health` → 200 `{status:"ok",db:"up"}` / 503 when the DB is down.
- Every error uses one JSON shape: `{ "error": { "code", "message", "details?", "requestId" } }`.
- Every response carries `X-Request-Id` (a safe incoming value is reused); it is on every log line.
- Money (Prisma `Decimal`) is always serialized as a **string** (`"1234.5"`), never a JSON number.
- Panel API (phase 8, ADR-018): `/api/v1/auth/*` (login, refresh with rotation, logout,
  logout-all, me) and `/api/v1/admin/*` (reviews, bot pause/resume, reply as a person, manual
  opt-out/opt-in, settings, users) — every admin route requires a Bearer token and a role
  (operator: line reviews, conversations, opt-out; admin: also run gates, catalog-wide
  proposals, opt-in, settings writes, users).
- Internal API for n8n (`X-Internal-Api-Key`, never used by the frontend), all idempotent:
  `POST /api/v1/internal/classify {messageId}`, `POST /api/v1/internal/extract {runId}`,
  `POST /api/v1/internal/catalog/ingest {runId}`, `GET /api/v1/internal/runs/:id` (status to
  poll), `GET /api/v1/internal/rules`, `POST /api/v1/internal/notifications`
  `{kind: run|customer_query|manual_attention}`, `POST /api/v1/internal/n8n/errors`,
  `POST /api/v1/internal/messages/ack {runId}`.
- Spreadsheets, CSV, text and Word files are converted to text by the worker before
  extraction (ADR-013); PDFs and images go to Claude as-is.
- Spreadsheets (xlsx/xls/csv) are read row by row by CODE with the supplier's remembered
  format (ADR-014). A new format gets one small LLM mapping call and a `column_mapping`
  review (a human picks the price column when there are several); the next lists in that
  format cost $0.
- Decisions the system must not take alone become **review items** (`review_items`, ADR-012):
  uncertain matches, outliers, currency changes, unavailable products, global percentages,
  tax-basis changes and suspicious messages. The admin panel (phase 9) resolves them.

## Environment variables

| Variable                                                             | Where        | Purpose                                                                  |
| -------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `POSTGRES_USER/PASSWORD/DB`                                          | root `.env`  | Postgres superuser and app database                                      |
| `N8N_DB_NAME/USER/PASSWORD`                                          | root `.env`  | n8n database and role (created on first volume init)                     |
| `N8N_ENCRYPTION_KEY`                                                 | root `.env`  | Encrypts n8n credentials — never change it                               |
| `N8N_WEBHOOK_URL`                                                    | root `.env`  | Public base URL n8n uses for webhook URLs                                |
| `TIMEZONE`                                                           | root `.env`  | n8n timezone (default `America/Montevideo`)                              |
| `NODE_ENV`, `PORT`                                                   | `apps/api`   | Runtime mode and HTTP port (default 4000)                                |
| `LOG_LEVEL`                                                          | `apps/api`   | Pino level (default `info`)                                              |
| `DATABASE_URL`                                                       | `apps/api`   | Postgres connection string                                               |
| `CORS_ORIGINS`                                                       | `apps/api`   | Comma-separated allowed origins (required in prod)                       |
| `RATE_LIMIT_WINDOW_MS/MAX`                                           | `apps/api`   | Global /api/v1 rate limit per IP (300 / 60 s)                            |
| `TRUST_PROXY`                                                        | `apps/api`   | Proxy hops in front of the API (0 local, 1 behind Caddy or Render)       |
| `WHATSAPP_*`                                                         | `apps/api`   | Meta app / WABA credentials — see `.env.example`                         |
| `WHATSAPP_GRAPH_BASE_URL`                                            | `apps/api`   | Graph API host; `http://localhost:4010` = simulator                      |
| `WEBHOOK_RATE_LIMIT_MAX`                                             | `apps/api`   | Per-IP limit for the WhatsApp webhook                                    |
| `WORKER_CONCURRENCY`                                                 | `apps/api`   | Parallel webhook jobs per worker process                                 |
| `MEDIA_MAX_BYTES`                                                    | `apps/api`   | Own media size cap (25 MB), on top of Meta limits                        |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`                                          | `apps/api`   | Timeout per media download (60 s)                                        |
| `MEDIA_WORKER_CONCURRENCY`                                           | `apps/api`   | Parallel media downloads per worker process                              |
| `OUTBOUND_WORKER_CONCURRENCY`                                        | `apps/api`   | Parallel outbound sends (order kept per conversation)                    |
| `TRANSCRIPTION_PROVIDER`                                             | `apps/api`   | `groq` \| `openai` \| `fake` (default; not allowed in production)        |
| `TRANSCRIPTION_API_KEY`                                              | `apps/api`   | Provider key (Groq free plan); required unless `fake`                    |
| `TRANSCRIPTION_BASE_URL/MODEL`                                       | `apps/api`   | Optional overrides (Groq: whisper-large-v3)                              |
| `TRANSCRIPTION_LANGUAGE`, `_TIMEOUT_MS`                              | `apps/api`   | Language hint (`es`) and request timeout                                 |
| `TRANSCRIPTION_WORKER_CONCURRENCY`                                   | `apps/api`   | Parallel transcriptions (Groq free: 20 req/min)                          |
| `TRANSCRIPTION_DAILY_LIMIT_PER_CONTACT`                              | `apps/api`   | Max transcriptions per contact per 24h (50)                              |
| `AI_PROVIDER`                                                        | `apps/api`   | `anthropic` \| `fake` (default; not allowed in production)               |
| `ANTHROPIC_API_KEY`                                                  | `apps/api`   | Claude API key; required when `AI_PROVIDER=anthropic`                    |
| `AI_CLASSIFIER_MODEL`, `AI_EXTRACTOR_MODEL`                          | `apps/api`   | Model ids (default `claude-sonnet-5`)                                    |
| `AI_TOTAL_BUDGET_USD`, `AI_DAILY_BUDGET_USD`                         | `apps/api`   | Own spend caps checked before every call ($4 / $0.50)                    |
| `AI_DAILY_LIMIT_PER_CONTACT`                                         | `apps/api`   | Max extractions per contact per UTC day (20)                             |
| `AI_MAX_RUN_USD`                                                     | `apps/api`   | Cap for all AI calls of one message/run ($0.30)                          |
| `DOC_CONVERT_MAX_BYTES/_SHEETS/_ROWS/_COLUMNS/_CHARS`                | `apps/api`   | Document conversion limits (10 MB, 10, 2000, 50, 40k)                    |
| `DOC_CONVERT_TIMEOUT_MS`, `_WORKER_CONCURRENCY`                      | `apps/api`   | Isolated conversion timeout (20 s) and parallelism (1)                   |
| `AI_TIMEOUT_MS`, `AI_PROMPT_CACHE`, `AI_FAKE_GOLDEN_DIR`             | `apps/api`   | Call timeout, prompt caching, fake golden outputs                        |
| `INTERNAL_API_KEY`                                                   | `apps/api`   | Secret for `/api/v1/internal/*` (n8n); min 32 chars                      |
| `INTERNAL_RATE_LIMIT_MAX`                                            | `apps/api`   | Per-IP limit for the internal API (600 / window)                         |
| `JWT_ACCESS_SECRET`                                                  | `apps/api`   | HS256 key for the 15-min panel access tokens; random, min 32 chars       |
| `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS` | `apps/api`   | Access token 900 s; session 24 h idle / 7 days max                       |
| `AUTH_COOKIE_SAMESITE/SECURE/PARTITIONED`                            | `apps/api`   | Refresh cookie by deploy mode (strict = same origin; see ADR-018)        |
| `LOGIN_RATE_LIMIT_MAX`                                               | `apps/api`   | Login attempts per IP per 15 min (10)                                    |
| `N8N_DELIVERY_ENABLED`                                               | `apps/api`   | Deliver message.ready events to n8n (default `false`)                    |
| `N8N_RECEIVER_WEBHOOK_URL`                                           | `apps/api`   | n8n receiver webhook (production URL, `/webhook/…`)                      |
| `N8N_WEBHOOK_SECRET`                                                 | `apps/api`   | `X-SmartOps-Secret` value; required when delivery is on                  |
| `TEST_DATABASE_URL`                                                  | `apps/api`   | Optional; enables integration tests (`*_test` DB)                        |
| `DEMO_MODE` and `DEMO_*`                                             | `apps/api`   | Public demo: fakes, reset interval, limits (ADR-021)                     |
| `DEMO_ORCHESTRATOR`, `DEMO_ORCHESTRATOR_API_URL`                     | `apps/api`   | `internal` = in-process orchestrator instead of n8n, demo only (ADR-025) |
| `PANEL_PUBLIC_URL`                                                   | `apps/api`   | Panel URL for the digest deep link `/d/<token>` (optional)               |
| `NEXT_PUBLIC_API_BASE`                                               | `apps/admin` | Where the browser calls the API (default `/api/v1`, same origin)         |
| `API_PROXY_TARGET`                                                   | `apps/admin` | Server only: API origin for the local `/api/*` rewrite                   |
| `PANEL_DEFAULT_LOCALE`                                               | `apps/admin` | Server only: `en` / `es` for people who did not choose (demo: en)        |

## Privacy: speech-to-text (Groq)

Voice notes are personal data and are sent to Groq for transcription (ADR-010). Since
2025-10-15 Groq may retain inference inputs and outputs — audio transcriptions included —
for up to 30 days for reliability and abuse monitoring **unless Zero Data Retention is
enabled**. **Requirement:** every Groq account used with this project (development,
demo and any real client) must enable ZDR in the Groq console → Settings → Data Controls
(Global ZDR, or at least Inference APIs ZDR) before `TRANSCRIPTION_PROVIDER=groq` is used.

### Public demo vs the real system

The public demo runs on a 1 GB free VM, so it uses the **light profile** (ADR-025): the n8n
workflows are played by an in-process orchestrator (`DEMO_ORCHESTRATOR=internal`, one sample at a
time) and the API and the worker run in one process (`node dist/demo-server.js`). The real system
uses n8n and separate processes. `apps/api/test/unit/orchestrator-parity.test.ts` runs the
exported workflows and the orchestrator side by side and fails if they ever make different calls.
