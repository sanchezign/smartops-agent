# SmartOps Agent

Multi-channel operations agent with AI. Suppliers, customers and staff send
information over WhatsApp in chaotic formats (text, PDFs, photos, voice notes);
SmartOps extracts structured data with Claude, keeps a product catalog up to
date, alerts the team and coexists with human operators on the same number.

> Status: **phase 2 — config/env/logging + initial Prisma schema**. See `CLAUDE.md` for the full phase plan and
> `docs/pitch.md` for the original pitch.

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

## Desarrollo sin Meta

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

## Scripts (root)

| Script              | What it does                            |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Runs every app in watch mode (parallel) |
| `pnpm build`        | Builds every app                        |
| `pnpm lint`         | ESLint in every app                     |
| `pnpm typecheck`    | `tsc --noEmit` in every app             |
| `pnpm test`         | Vitest (API)                            |
| `pnpm format`       | Prettier write                          |
| `pnpm format:check` | Prettier check                          |

Per app: `pnpm --filter @smartops/api <script>` / `pnpm --filter @smartops/admin <script>`.

API processes (run with `pnpm --filter @smartops/api <script>`):

| Script          | What it does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| `dev`           | HTTP server + worker in watch mode (`dev:api` and `dev:worker`)           |
| `start`         | HTTP server from `dist/` (webhooks, API)                                  |
| `start:worker`  | Worker from `dist/` (pg-boss: webhook processing, dead letters, sweeper)  |
| `wa:subscribe`  | Subscribes the Meta app to the WABA webhooks (idempotent)                 |
| `wa:simulate`   | Sends signed WhatsApp webhooks to the local API (see Desarrollo sin Meta) |
| `wa:fake-graph` | Local fake Meta Graph API on :4010 (see Desarrollo sin Meta)              |

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

## API conventions

- All routes under `/api/v1/`. Health: `GET /api/v1/health` → 200 `{status:"ok",db:"up"}` / 503 when the DB is down.
- Every error uses one JSON shape: `{ "error": { "code", "message", "details?", "requestId" } }`.
- Every response carries `X-Request-Id` (a safe incoming value is reused); it is on every log line.
- Money (Prisma `Decimal`) is always serialized as a **string** (`"1234.5"`), never a JSON number.
- Internal API for n8n (`X-Internal-Api-Key`, never used by the frontend), all idempotent:
  `POST /api/v1/internal/classify {messageId}`, `POST /api/v1/internal/extract {runId}`,
  `POST /api/v1/internal/catalog/ingest {runId}`, `GET /api/v1/internal/runs/:id` (status to
  poll), `GET /api/v1/internal/rules`.
- Spreadsheets, CSV, text and Word files are converted to text by the worker before
  extraction (ADR-013); PDFs and images go to Claude as-is.
- Decisions the system must not take alone become **review items** (`review_items`, ADR-012):
  uncertain matches, outliers, currency changes, unavailable products, global percentages,
  tax-basis changes and suspicious messages. The admin panel (phase 9) resolves them.

## Environment variables

| Variable                                                 | Where        | Purpose                                                    |
| -------------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| `POSTGRES_USER/PASSWORD/DB`                              | root `.env`  | Postgres superuser and app database                        |
| `N8N_DB_NAME/USER/PASSWORD`                              | root `.env`  | n8n database and role (created on first volume init)       |
| `N8N_ENCRYPTION_KEY`                                     | root `.env`  | Encrypts n8n credentials — never change it                 |
| `N8N_WEBHOOK_URL`                                        | root `.env`  | Public base URL n8n uses for webhook URLs                  |
| `TIMEZONE`                                               | root `.env`  | n8n timezone (default `America/Montevideo`)                |
| `NODE_ENV`, `PORT`                                       | `apps/api`   | Runtime mode and HTTP port (default 4000)                  |
| `LOG_LEVEL`                                              | `apps/api`   | Pino level (default `info`)                                |
| `DATABASE_URL`                                           | `apps/api`   | Postgres connection string                                 |
| `CORS_ORIGINS`                                           | `apps/api`   | Comma-separated allowed origins (required in prod)         |
| `RATE_LIMIT_WINDOW_MS/MAX`                               | `apps/api`   | Global /api/v1 rate limit per IP (300 / 60 s)              |
| `TRUST_PROXY`                                            | `apps/api`   | Proxy hops in front of the API (0 local, 1 Render)         |
| `WHATSAPP_*`                                             | `apps/api`   | Meta app / WABA credentials — see `.env.example`           |
| `WHATSAPP_GRAPH_BASE_URL`                                | `apps/api`   | Graph API host; `http://localhost:4010` = simulator        |
| `WEBHOOK_RATE_LIMIT_MAX`                                 | `apps/api`   | Per-IP limit for the WhatsApp webhook                      |
| `WORKER_CONCURRENCY`                                     | `apps/api`   | Parallel webhook jobs per worker process                   |
| `MEDIA_MAX_BYTES`                                        | `apps/api`   | Own media size cap (25 MB), on top of Meta limits          |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`                              | `apps/api`   | Timeout per media download (60 s)                          |
| `MEDIA_WORKER_CONCURRENCY`                               | `apps/api`   | Parallel media downloads per worker process                |
| `OUTBOUND_WORKER_CONCURRENCY`                            | `apps/api`   | Parallel outbound sends (order kept per conversation)      |
| `TRANSCRIPTION_PROVIDER`                                 | `apps/api`   | `groq`                                                     | `openai` | `fake` (default; not allowed in production) |
| `TRANSCRIPTION_API_KEY`                                  | `apps/api`   | Provider key (Groq free plan); required unless `fake`      |
| `TRANSCRIPTION_BASE_URL/MODEL`                           | `apps/api`   | Optional overrides (Groq: whisper-large-v3)                |
| `TRANSCRIPTION_LANGUAGE`, `_TIMEOUT_MS`                  | `apps/api`   | Language hint (`es`) and request timeout                   |
| `TRANSCRIPTION_WORKER_CONCURRENCY`                       | `apps/api`   | Parallel transcriptions (Groq free: 20 req/min)            |
| `TRANSCRIPTION_DAILY_LIMIT_PER_CONTACT`                  | `apps/api`   | Max transcriptions per contact per 24h (50)                |
| `AI_PROVIDER`                                            | `apps/api`   | `anthropic` \| `fake` (default; not allowed in production) |
| `ANTHROPIC_API_KEY`                                      | `apps/api`   | Claude API key; required when `AI_PROVIDER=anthropic`      |
| `AI_CLASSIFIER_MODEL`, `AI_EXTRACTOR_MODEL`              | `apps/api`   | Model ids (default `claude-sonnet-5`)                      |
| `AI_TOTAL_BUDGET_USD`, `AI_DAILY_BUDGET_USD`             | `apps/api`   | Own spend caps checked before every call ($4 / $0.50)      |
| `AI_DAILY_LIMIT_PER_CONTACT`                             | `apps/api`   | Max extractions per contact per UTC day (20)               |
| `AI_MAX_RUN_USD`                                         | `apps/api`   | Cap for all AI calls of one message/run ($0.30)            |
| `DOC_CONVERT_MAX_BYTES/_SHEETS/_ROWS/_COLUMNS/_CHARS`    | `apps/api`   | Document conversion limits (10 MB, 10, 2000, 50, 40k)      |
| `DOC_CONVERT_TIMEOUT_MS`, `_WORKER_CONCURRENCY`          | `apps/api`   | Isolated conversion timeout (20 s) and parallelism (1)     |
| `AI_TIMEOUT_MS`, `AI_PROMPT_CACHE`, `AI_FAKE_GOLDEN_DIR` | `apps/api`   | Call timeout, prompt caching, fake golden outputs          |
| `INTERNAL_API_KEY`                                       | `apps/api`   | Secret for `/api/v1/internal/*` (n8n); min 32 chars        |
| `INTERNAL_RATE_LIMIT_MAX`                                | `apps/api`   | Per-IP limit for the internal API (600 / window)           |
| `TEST_DATABASE_URL`                                      | `apps/api`   | Optional; enables integration tests (`*_test` DB)          |
| `NEXT_PUBLIC_API_URL`                                    | `apps/admin` | Base URL of the API                                        |

## Privacy: speech-to-text (Groq)

Voice notes are personal data and are sent to Groq for transcription (ADR-010). Since
2025-10-15 Groq may retain inference inputs and outputs — audio transcriptions included —
for up to 30 days for reliability and abuse monitoring **unless Zero Data Retention is
enabled**. **Requirement:** every Groq account used with this project (development,
demo and any real client) must enable ZDR in the Groq console → Settings → Data Controls
(Global ZDR, or at least Inference APIs ZDR) before `TRANSCRIPTION_PROVIDER=groq` is used.

## Architecture decisions

- [ADR-001](docs/adr/ADR-001-pnpm-monorepo.md) — pnpm workspaces monorepo
- [ADR-002](docs/adr/ADR-002-n8n-orchestration.md) — n8n for multi-agent orchestration
- [ADR-003](docs/adr/ADR-003-pg-boss-queue.md) — pg-boss for async jobs
- [ADR-004](docs/adr/ADR-004-claude-api.md) — Claude API for classification and extraction
- [ADR-005](docs/adr/ADR-005-whisper-transcription.md) — Whisper-compatible speech-to-text
- [ADR-006](docs/adr/ADR-006-no-oauth.md) — No OAuth, JWT only
- [ADR-007](docs/adr/ADR-007-deploy-render.md) — Deploy everything on Render
- [ADR-008](docs/adr/ADR-008-media-storage.md) — Media stored in Postgres (bytea) behind `MediaStorage`
- [ADR-009](docs/adr/ADR-009-whatsapp-opt-in.md) — Opt-in required for business-initiated WhatsApp messages
- [ADR-010](docs/adr/ADR-010-transcription-provider.md) — Groq whisper-large-v3 (free plan) for speech-to-text
- [ADR-011](docs/adr/ADR-011-llm-provider-models-budget.md) — LLM provider, Claude models, spend guard and prompt-injection policy
- [ADR-012](docs/adr/ADR-012-human-review.md) — Catalog ingest rules and human review items
- [ADR-013](docs/adr/ADR-013-document-conversion.md) — Document conversion (xlsx/xls/csv/txt/docx) with isolation and limits
