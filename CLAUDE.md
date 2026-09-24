# CLAUDE.md

## Project
SmartOps Agent — multi-channel operations agent with AI. Suppliers,
customers and internal staff send information over WhatsApp in chaotic
formats (text, PDFs, photos, voice notes). SmartOps extracts structured
data with Claude, keeps a product catalog up to date, alerts the team, and
coexists with human operators on the same WhatsApp number. Portfolio
project built to production standard so it can be delivered to a real
client. Start date: 2026-09-24. Original pitch: docs/pitch.md.

## Stack profile
express-postgres

## Deploy target
render

## Tests
required

## Architecture (decided — do not re-open without an ADR)
- `apps/api` — Express 5 + TypeScript + Prisma + PostgreSQL. OWNS: the Meta
  webhook (signature, idempotency), media download, transcription, AI
  extraction, validation, catalog rules, coexistence state, internal API for
  n8n, public API for the admin panel, real-time events (SSE).
- `n8n` — self-hosted (Docker, Postgres-backed). OWNS: orchestration of the
  three agents as visual workflows. Calls the backend; never writes to the DB
  directly.
- `apps/admin` — Next.js 15 admin panel (noindex).
- Claude API (Anthropic) for classification and extraction. Model ids in env
  vars: classifier `claude-haiku-4-5` (fast/cheap), extractor
  `claude-sonnet-5` (PDF + image input, structured output). Verify ids and
  PDF/image input format in the official docs before implementing.
- Speech-to-text: Whisper-compatible API behind `Transcriber` (provider chosen
  in the phase 4 plan, e.g. OpenAI or Groq). Claude does NOT take audio input,
  so voice notes are transcribed first.

Message flow:
```
WhatsApp Cloud API ──webhook──▶ api: verify signature → store raw → ack 200 → enqueue (pg-boss)
  worker: dedupe by message.id → download media → transcribe audio → persist Message
        → if conversation is in HUMAN mode: stop (no bot action)
        → POST n8n "receiver" webhook (secret header)
n8n receiver agent: classify → price_list_full | price_update_partial | customer_query | internal_order | other
n8n processor agent: call api /internal/extract (Claude) → call api /internal/catalog/ingest
        api validates: duplicates, invalid prices, missing fields, currency;
        full list vs partial update; writes Products + PriceChanges; returns report
n8n notifier agent: price changes over threshold, low stock, missing data
        → WhatsApp template / message to the team; reply/ack to the sender
```

## Phase order
Week 1
1. scaffold — pnpm monorepo (`apps/api`, `apps/admin`, `n8n/workflows`,
   `docs/adr`), docker-compose: Postgres (databases `smartops` + `n8n`) + n8n.
   Root scripts: dev, build, lint, typecheck, test.
2. config/env/logging — Zod env, pino-http + request-id, AppError + error
   middleware, helmet, cors, rate limit, `/api/v1/health` (checks DB).
   Prisma initial schema + first migration.
3. core integration — WhatsApp Business Cloud API:
   - GET `/api/v1/webhooks/whatsapp`: verification (hub.mode, hub.verify_token, hub.challenge)
   - POST `/api/v1/webhooks/whatsapp`: X-Hub-Signature-256 over RAW body with
     the App Secret → 401 if invalid; ack 200; enqueue in pg-boss
   - Idempotency: unique `waMessageId`
   - Message types: text, image, document (PDF), audio; store statuses
     (sent/delivered/read) without triggering the bot
   - Media: media id → Graph API URL (short-lived) → download with token;
     validate mime/size; store file (storage choice in the plan: Postgres
     bytea for the MVP vs S3-compatible bucket; record an ADR)
   - Outbound client: text, template messages; respect the 24h window
     (outside it only approved templates)
   - Fixtures: real sample payloads in `apps/api/test/fixtures/whatsapp/`

Week 2
4. media normalization — `Transcriber` (Whisper) for audio/ogg voice notes;
   transcript stored on the Message; PDFs and images passed to extraction as-is.
5. extraction + catalog — `ai/` module (Anthropic SDK behind provider
   interface, prompts in `apps/api/src/ai/prompts/*.md`, output validated with
   Zod, timeout + fallback, tokens/latency logged). Internal routes (API key):
   `/api/v1/internal/extract`, `/api/v1/internal/catalog/ingest`,
   `/api/v1/internal/rules`. Catalog rules: normalize product names,
   detect duplicates, invalid/negative/outlier prices, missing fields,
   currency; full list (mark missing products unavailable) vs partial
   update; every price change recorded in PriceChange.
6. n8n multi-agent — three workflows (receiver, processor, notifier) using
   the backend as tools. Deliver workflow JSON drafts + node-by-node
   instructions; the user builds/tests them in the n8n UI and exports the
   final JSON to `n8n/workflows/` (no credentials).

Week 3
7. coexistence human + bot — same number via WhatsApp Business app
   coexistence (verify current availability/requirements in Meta docs,
   including the webhook field for messages the human sends from the app,
   e.g. message echoes). Rules: a human message (from the phone app or from
   the panel) switches the conversation to HUMAN mode; bot reactivates after
   a configurable timeout (scheduled pg-boss job) or manually from the panel.
   Fallback if coexistence is not available for the number: humans reply
   only from the panel.
8. admin auth — JWT access + refresh, roles `admin` and `operator`. No OAuth.
9. admin UI — Next.js (noindex), real-time via SSE:
   - Dashboard: messages processed, automation rate, errors, per day
   - Catalog: products by supplier, live updates
   - Price history per supplier/product (chart)
   - Conversations: inbox, chat view, who is answering (bot/human) badge,
     pause/activate bot per chat, reply as human
   - Rules (no-code config): price-change alert %, low-stock threshold,
     human-takeover timeout, alert recipients, bot on/off, business hours

Week 4
10. tests — unit: signature check, idempotency, catalog rules, coexistence
    state machine, extraction schema validation (mocked LLM). e2e: webhook
    with fixtures (valid, invalid signature, duplicate delivery), internal
    API auth, ingest full vs partial.
11. CI/CD — GitHub Actions: lint + typecheck + test + build (Postgres
    service container for e2e).
12. deploy config — render.yaml Blueprint: `api` (web service + worker
    process or separate worker), `admin` (web service), `n8n` (Docker image
    service), Render Postgres (shared instance, separate `n8n` database).
    Webhook receiver and n8n need paid instances (no sleep); free Postgres
    has limits — verify current Render plans and document the monthly cost
    in the README. `prisma migrate deploy` on release.
13. docs — README: problem, architecture diagram, flow, setup with Meta test
    number, env var table, demo GIF, cost estimate, ADR list.

## Data model (starting point — refine in phase 2 plan)
Supplier · Contact (waId unique, kind supplier|customer|internal) ·
Conversation (mode bot|human, humanUntil) · Message (waMessageId unique,
direction, type, author contact|bot|human, text, transcript, mediaId) ·
MediaFile · Product (supplierId + normalizedName unique, price Decimal,
currency, available, stock) · PriceChange (old, new, source message) ·
IngestionRun (classification, raw extraction JSON, status, errors) ·
Alert · Setting/Rule · User (admin|operator) · AuditLog

## Stack deviations
- Monorepo with pnpm workspaces — one repo for the portfolio.
- n8n (optional module) — orchestration of the multi-agent workflows.
- pg-boss queue (profile queue) — webhook processing must be async.
- AI/LLM: Claude API via Anthropic SDK (optional module).
- Speech-to-text: Whisper-compatible API (optional module).
- No OAuth — internal panel uses JWT only.
- Deploy target `render` — all services on Render (no Vercel).
Each one gets an ADR in docs/adr/.

## Architecture decisions
- 2026-09-24 (phase 1) Versions pinned: Next 15.5.26, React 19.1.0,
  TypeScript ~5.9.3, Express ^5.2.1, Tailwind v4 (CSS config), Vitest 5,
  n8n image `docker.n8n.io/n8nio/n8n:2.40.6`, `postgres:17-alpine`, pnpm 12.6,
  Node 24. Prisma 7.10 is installed in phase 2.
- ESLint pinned to 9.x repo-wide: `eslint-config-next@15.5` only supports
  ESLint <= 9 (see ADR-001).
- pnpm `allowBuilds`: `esbuild: true`, `unrs-resolver: false` (prebuilt binary
  ships as an optional dep).
- Local infra: ports published on 127.0.0.1 only; n8n uses its own Postgres
  role + database (`n8n`), created by `docker/postgres/init/01-create-n8n-db.sh`
  (runs only on first volume creation); n8n timezone default
  `America/Montevideo`.
- API test layout: Vitest picks `apps/api/test/**/*.test.ts`; build uses
  `tsconfig.build.json` (src only).
- Package names: `@smartops/api`, `@smartops/admin`.
- 2026-09-24 (phase 2) Prisma pinned EXACTLY to 7.10.0 (`prisma`,
  `@prisma/client`, `@prisma/adapter-pg`): npm `prisma@latest` points to
  8.0.0-rc (pre-release). Do not upgrade to 8 without a plan.
- Prisma 7 setup: generator `prisma-client` (esm, `importFileExtension = "js"`)
  → `apps/api/src/generated/prisma/` (gitignored + ESLint/Prettier ignored,
  regenerated by build/typecheck/test). URL in `apps/api/prisma.config.ts`
  (reads `process.env.DATABASE_URL`, not `env()`, so `prisma generate` works
  without a DB). pg driver adapter; `?schema=` in the URL is ignored.
- `.env` loading: Node built-in (`--env-file-if-exists=.env` in dev/start,
  `process.loadEnvFile` in prisma.config.ts). No dotenv.
- pnpm `allowBuilds`: `prisma: true`, `@prisma/engines: true` (schema engine download).
- Composition: `createApp({ env, logger, healthRepository })` — dependencies
  injected, so e2e tests run without Postgres. server.ts owns the single
  PrismaClient, fails fast if env is invalid or the DB is unreachable.
- Env cross-field rules (e.g. CORS_ORIGINS required in production) live in
  `crossFieldIssues` in env.ts, not in a Zod superRefine (skipped when a field fails).
- Data model: UUIDv7 ids (`@db.Uuid`), `timestamptz(3)`, snake_case tables,
  createdAt+updatedAt on every mutable model (PriceChange/AuditLog are append-only:
  createdAt only). One Conversation per Contact. Money `Decimal(18,4)`;
  `PriceChange.changePct` is unbounded `numeric` (outliers must fit).
- PriceChange rule: currency changed → `changePct = null`, `currencyChanged = true`.
  Computed by `src/modules/catalog/price-change.ts` AND enforced by CHECK
  constraints in migration `price_change_rules` (Prisma does not model CHECKs —
  keep them when editing the model).
- `validate()` stores parsed input in `res.locals.validated` (Express 5 `req.query`
  is read-only); read it with `getValidated<typeof schema>(res, "body")`.
- Request logs: compact serializers (req id/method/url/ip, res statusCode);
  `/api/v1/health` logged at debug. Redacted headers: authorization, cookie,
  x-hub-signature-256, x-internal-api-key, set-cookie.
- Rate limit: global on /api/v1 (health skipped), 429 goes through the error
  middleware. Phase 3: webhook router mounted before `express.json` (raw body)
  with its own limit.

## Current phase
1. scaffold — done (2026-09-24).
2. config/env/logging + initial Prisma schema — done (2026-09-24). Migrations:
   `init`, `price_change_rules`. Next: 3. core integration (WhatsApp Cloud API).

## Known issues (out of scope)
- n8n 2.40.6 logs "Failed to start Python task runner… Python 3 is missing"
  at startup. JS Code nodes work; Python Code nodes would need an external
  runner. Not needed so far.
- ESLint 9.x is flagged deprecated by npm; blocked on eslint-config-next 15.5.
- Prisma CLI prints an "Update available 7.10.0 -> 8.0.0-rc" banner on every
  generate. Ignore it (see pin decision).
- Startup fail-fast log when the DB is unreachable is terse ("Invalid
  `prisma.$queryRaw()` invocation"); the cause is in `err.meta`. Cosmetic.

## Conventions in this project
- WhatsApp fixtures: `apps/api/test/fixtures/whatsapp/`
- Prompts: `apps/api/src/ai/prompts/*.md`
- n8n workflows: `n8n/workflows/{receiver,processor,notifier}.json`
- Internal API for n8n: `/api/v1/internal/*` with `X-Internal-Api-Key`
- Real-time events to the panel: SSE at `/api/v1/events`
- Decimal serialization: every Prisma `Decimal` (money, percentages) is sent
  as a JSON **string** in plain notation (`"1234.5"`, never a number, never
  exponent notation). Enforced by `decimalJsonReplacer` registered as Express
  `json replacer`; anything not sent via `res.json` (SSE, n8n payloads) must
  use `toJson()` from `src/common/json.ts`. Frontend/n8n parse these as strings
  (never `parseFloat` for arithmetic).
- Error shape: `{ "error": { "code", "message", "details?", "requestId" } }`.
  Throw `AppError` / `errors.*` from `src/common/errors/app-error.ts`.
- API modules: factories with injected deps
  (`createXRepository(prisma)` → `createXService({...})` → `createXController` →
  `createXRouter`), mounted in `app.ts` on the `/api/v1` router.
