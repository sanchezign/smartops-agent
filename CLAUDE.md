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
- 2026-09-24 (phase 3, milestone 1) WhatsApp webhook at `/api/v1/webhooks/whatsapp`
  (`src/modules/whatsapp/`): `express.raw` 3mb (Meta max payload), own rate limit
  `WEBHOOK_RATE_LIMIT_MAX` (excluded from the global limiter), HMAC check with
  `timingSafeEqual`, verify token compared in constant time. Graph API `v26.0`
  (env `WHATSAPP_GRAPH_API_VERSION`). WhatsApp env vars are REQUIRED at startup
  in every environment.
- `WebhookEvent` (table `webhook_events`, migration `webhook_events`): every
  signature-valid delivery is stored before the 200; unique (`provider`,
  `body_sha256`) = SHA-256 of the raw body → identical Meta re-deliveries are
  acked 200 and not stored twice. Message-level idempotency stays on
  `Message.waMessageId` (milestone 2).
- Phone numbers are MASKED in logs (`maskPhone`: `598*****160`, first 3 + last 3;
  `maskPhonesInText` for provider error texts). Full values only in the DB. Logs
  never include message bodies, contact names or media ids. `hub.verify_token` is
  redacted from request-log URLs.
- Milestone 1 logs a log-safe summary of each delivery (status + Meta error codes)
  inline — read-only diagnostics; processing moves to the pg-boss worker in milestone 2.
- `src/modules/whatsapp/graph-api.ts`: shared Graph API fetch helper (timeout,
  typed `GraphApiError`). CLI `pnpm --filter @smartops/api wa:subscribe` ensures
  the app is subscribed to the WABA (`/{WABA_ID}/subscribed_apps`).
- 2026-09-24 (phase 3, milestone 2) Webhook processing via pg-boss 12 (schema
  `pgboss`, pool max 5 per process). Queues: `whatsapp-webhook` (retryLimit 5,
  backoff 5s→300s, expire 60s, DLQ `whatsapp-webhook-dlq` created first),
  `webhook-sweeper` (cron every minute). API process = send only
  (`supervise:false, schedule:false`); worker process `src/worker.ts` runs workers,
  maintenance and cron. `pnpm dev` in apps/api runs `dev:api` + `dev:worker`.
- Outbox: `WebhookEvent` is the source of truth. Receive = store → try enqueue →
  `enqueuedAt` → ALWAYS 200 once stored. Enqueue failures are recovered by the
  sweeper (events `received` + `enqueuedAt` null older than 60s). pg-boss
  `singletonKey` is throttling, not a uniqueness guarantee → idempotency lives in
  the worker (event not `received` → skip; unique `waMessageId`; unique
  `MessageStatusEvent (waMessageId, status)`).
- Dead letters: DLQ worker marks the event `failed` (only if still `received`);
  every failed attempt stores the error in `webhook_events.error`.
- Events for another `phone_number_id` (Meta dashboard "Test" sample uses
  `123456123`) or fields not handled yet are marked `ignored` (new enum value).
- Contact identity: phone (`waId`, now nullable) and/or Meta BSUID (`bsuid`,
  unique) + `username`; CHECK `contacts_identity_chk` (one of them required) in
  migration `whatsapp_worker` — keep it when editing Contact. Resolution by bsuid,
  then waId; missing ids are filled in; two different contacts are never merged
  (warn log). Pure rules in `contact-identity.ts`. BSUIDs are masked in logs
  (`US.134…918`, `maskUserId`).
- Outbound status rules (`message-status.ts`): forward-only pending<sent<delivered<read,
  played→read; failed overrides pending/sent/delivered, never read; failed is final.
  Applied with a conditional `updateMany` (atomic). Statuses for unknown wamids are
  kept with `messageId = null` (M4 backfills when an outbound message gets its wamid).
- Conversation `lastInboundAt`/`lastMessageAt` are monotonic (SQL GREATEST).
- Parser (`whatsapp-webhook.parser.ts`) validates items one by one: an invalid item
  is logged (`invalid_items`) and skipped, never fails the whole delivery.
- Integration tests: `test/integration` against real Postgres when
  `TEST_DATABASE_URL` is set (name must end in `_test`; global setup creates the DB
  and runs `prisma migrate deploy`; tables are TRUNCATEd). Skipped otherwise.
- `prisma migrate dev` refuses to run non-interactively when adding enum values;
  migration `whatsapp_worker` was generated with `prisma migrate diff` +
  `migrate deploy`.
- 2026-09-24 (phase 3, M2.5) Local WhatsApp simulator (dev tooling, not built:
  `apps/api/scripts/simulator/`). `wa:simulate` = Meta → API (signed webhooks built
  by `payloads.ts`, unit-tested against the production parser). `wa:fake-graph` =
  API → Meta: `node:http` server (127.0.0.1:4010) with Graph paths/auth/error shapes:
  media metadata + expiring signed download URL (`/media-download/{id}`, Bearer
  required), POST `/{phone-number-id}/messages` → wamid + signed status webhooks
  back, `subscribed_apps`; faults via flags. Shared media dir `apps/api/.sim/media`
  (gitignored + prettierignored). Only production change:
  `WHATSAPP_GRAPH_BASE_URL` (default `https://graph.facebook.com`; env.ts rejects
  any other value in production) used by `graph-api.ts` (`GraphApiConfig.baseUrl`).
  Default simulator media sha256 format: hex (`--sha-format base64` available).
- 2026-09-24 (phase 3, M3) Media download (ADR-008): bytes in `media_blobs` (bytea,
  STORAGE EXTERNAL set in migration `media_storage` — keep it) behind `MediaStorage`
  (`src/modules/media/`). MediaFile.status pending|stored|skipped|rejected|failed +
  rejectReason/error/attempts/contentSha256 (`sha256` = Meta's declared value).
  Policy (`media-policy.ts`, pure): whitelist per message type, effective cap =
  min(Meta limit, MEDIA_MAX_BYTES), magic-byte sniffing, sha256 hex OR base64. Video and
  sticker → skipped at ingest (no job); unsupported declared mime → rejected at ingest.
- Media job enqueued INSIDE the ingestion transaction with pg-boss `fromPrisma(tx)`
  (`createEnqueueMediaInTx`); verified against real pg-boss (rollback → no job). Queue
  `whatsapp-media` (retryLimit 6, backoff 10s→30min, expire 180s, DLQ
  `whatsapp-media-dlq` → failed/retries_exhausted), `MEDIA_WORKER_CONCURRENCY`.
- Download error policy: media id 404 → failed (no retry); URL 404 → one fresh URL in
  the same attempt; 401/403/190 → retry + loud "renew token" log; too large / bad
  mime / content mismatch / empty → rejected; 5xx, timeout, network, checksum mismatch
  → retry. `wa:media:retry` resets failed → pending and re-enqueues.
- Access token only sent to allowed download hosts (`isAllowedDownloadUrl`): HTTPS
  graph.facebook.com, lookaside.fbsbx.com, *.fbsbx.com; outside production also the
  `WHATSAPP_GRAPH_BASE_URL` host. Download URLs are never logged.
- Vitest projects: `unit` (unit + e2e, parallel) and `integration` (global setup,
  `fileParallelism: false` — files share and TRUNCATE the test DB).
- Local tunnel: cloudflared quick tunnel (`cloudflared tunnel --url
  http://localhost:4000`); URL changes on every restart → update it in Meta.

## Current phase
1. scaffold — done (2026-09-24).
2. config/env/logging + initial Prisma schema — done (2026-09-24). Migrations:
   `init`, `price_change_rules`.
3. core integration (WhatsApp Cloud API) — IN PROGRESS. Approved plan milestones:
   M1 webhook verify + signed capture + status diagnostics — done (2026-09-24).
   Checkpoint: real Meta webhook verified (signed test event stored once;
   wa:subscribe subscribed the app to the WABA). The real failed-status error code
   is still pending: Meta says the test number is still being set up.
   2026-09-24: Meta disabled the portfolio + WABA (review requested, see Known
   issues) → continue with a local WhatsApp simulator.
   M2.5 local WhatsApp simulator (`wa:simulate` + `wa:fake-graph`) — done
   (2026-09-24).
   M3 media download + storage (ADR-008) — done (2026-09-24), tested against the fake
   Graph API. Migration `media_storage`.
   Next: M4 outbound client + 24h window + CLI send script (fake Graph API), then M5.
   M2 pg-boss queue + worker + idempotent persistence — done (2026-09-24),
   branch `feat/phase-3-whatsapp`. Migration `whatsapp_worker`.
   Next: M3 media download + storage (ADR-008: bytea behind
   `MediaStorage`, 25 MB cap) → M4 outbound client + 24h window + CLI send script
   → M5 real anonymized fixtures + tests.

## Known issues (out of scope)
- **BLOCKER (external), 2026-09-24: Meta disabled the business portfolio and the
  WABA** for "Acceptable Use Policy" (likely a false positive on a new account).
  The user requested a review. Until it is restored there are no real webhooks,
  outbound sends, media downloads or templates, and the real failed-status error
  code (M1 checkpoint) cannot be obtained. Development continues against a local
  simulator. When the account is back: re-run `wa:subscribe`, re-check the webhook
  config in the App Dashboard, and validate M1–M3 end to end with real traffic.
  If the review is rejected, a new portfolio/WABA (new ids in `.env`) is needed.
- **Local `apps/api/.env` points at the simulator**: `WHATSAPP_GRAPH_BASE_URL=http://localhost:4010`
  (added 2026-09-24 while Meta is blocked). When Meta restores the account, REMOVE that
  line (default = `https://graph.facebook.com`) to use the real Graph API again, restart
  API + worker, then run `wa:subscribe`.
- **Phase 5 (extraction):** Claude reads PDF and images natively, but NOT xlsx / xls /
  csv / docx. Those documents are stored in M3 but must be converted to text (e.g. sheet →
  CSV/Markdown table) before extraction. Evaluate the parsing library and record an ADR
  in phase 5.
- `onInboundMessage` hook (phases 6/7) runs after the message is committed: if it
  throws, the job retries but the message is then a duplicate and the hook is NOT
  called again. Phase 6 must make the hand-off durable (enqueue its own job /
  outbox) instead of calling n8n inline from the hook.
- Real WhatsApp payloads are pending (test number still being set up in Meta):
  fixtures are doc-based. Replace in M5 with anonymized real captures.
- `media_blobs` has no retention yet (ADR-008): media is kept forever and grows the DB
  and its backups. Define a retention policy (e.g. delete blobs of processed media after
  N days, keep extracted data) before real traffic.
- Allowed media download hosts (graph.facebook.com, *.fbsbx.com) come from docs and
  community reports; confirm with real Meta traffic when the account is restored.
- `webhook_events` has no retention yet: every delivery is kept forever (payloads
  up to 3 MB). Future: scheduled pg-boss cleanup job (e.g. delete `processed` events
  older than N days, keep `failed` longer), N configurable.
- n8n 2.40.6 logs "Failed to start Python task runner… Python 3 is missing"
  at startup. JS Code nodes work; Python Code nodes would need an external
  runner. Not needed so far.
- ESLint 9.x is flagged deprecated by npm; blocked on eslint-config-next 15.5.
- Prisma CLI prints an "Update available 7.10.0 -> 8.0.0-rc" banner on every
  generate. Ignore it (see pin decision).
- Startup fail-fast log when the DB is unreachable is terse ("Invalid
  `prisma.$queryRaw()` invocation"); the cause is in `err.meta`. Cosmetic.

## Conventions in this project
- Git / GitHub backup (user rule, 2026-09-24): remote `origin` =
  https://github.com/sanchezign/smartops-agent (private). At the end of EVERY milestone,
  right after its commit, run `git push` of the CURRENT branch (never `--force`).
  Any other push — other branches, force pushes, tags, deleting remote branches — must
  be asked first. Run the secrets audit (no `.env`/`.sim` tracked, no real tokens)
  before pushing.
- WhatsApp fixtures: `apps/api/test/fixtures/whatsapp/`
- Local WhatsApp without Meta: `wa:simulate` + `wa:fake-graph` (README "Desarrollo
  sin Meta"). New WhatsApp features must work against the fake Graph API; extend
  `fake-graph.ts` when a phase needs a new Graph endpoint.
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
