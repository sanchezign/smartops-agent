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
Custom $0 target (user decision 2026-09-24, see "Cost constraint"; replaces `render`):
- Option A (preferred): Oracle Cloud Always Free VM (ARM, 2 OCPU / 12 GB) running the
  same docker compose (api, worker, n8n, postgres) + Caddy (Let's Encrypt HTTPS);
  admin panel on Vercel Hobby.
- Option B (fallback): Render free (api + worker in ONE process in demo mode; n8n
  separate) + Supabase free Postgres + Vercel Hobby.
This is not one of the standard targets (`vercel-render` | `render`): record it in an
ADR (superseding ADR-007) when phase 12 starts.

## Cost constraint (user rule, 2026-09-24)
Portfolio demo with a target of **$0 infrastructure** (max ~5 USD of Claude API
credits). **Nothing that generates charges without asking the user first** (paid
plans, paid APIs beyond the Claude credits, domains, credit-card-only trials).
- Phase 4: Groq FREE plan only (whisper-large-v3: 20 req/min, 2,000 req/day,
  7,200 audio s/hour, 28,800 audio s/day, 25 MB files; 429 + retry-after when
  exceeded). ZDR REQUIRED on every Groq account (dev, demo, client): without it Groq may
  retain inputs/outputs, audio included, for up to 30 days (since 2025-10-15; ADR-010).
  The user enabled Global ZDR on the project account (2026-09-24).
- Phase 5: Claude API with a spend limit set in the Anthropic Console (≤ ~5 USD) +
  a "fake" LLM provider for development, tests and a demo without a key.
- Phase 12: $0 deploy (see Deploy target). NOT Neon for Postgres: pg-boss and n8n poll
  constantly and would burn its compute hours. Also document (README) the paid deploy
  for a real client (cost estimate).

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
  vars: classifier and extractor both `claude-sonnet-5` (ADR-011: at our volume it costs
  about the same as Haiku 4.5 for classification; PDF + image input, structured output). Verify ids and
  PDF/image input format in the official docs before implementing.
- Speech-to-text: Whisper-compatible API behind `Transcriber` (provider chosen
  in the phase 4 plan, e.g. OpenAI or Groq). Claude does NOT take audio input,
  so voice notes are transcribed first.

Message flow:
```
WhatsApp Cloud API ──webhook──▶ api: verify signature → store raw → ack 200 → enqueue (pg-boss)
  worker: dedupe by message.id → download media → transcribe audio → persist Message
        → HUMAN mode pauses only automatic replies to the contact (ack, bot answers);
          list processing, catalog and team notifications continue (ADR-016)
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
   The router must decide full vs partial with the EXTRACTION's `listKind` (explicit
   evidence rule), never with the classifier's label (user decision 2026-09-25: the
   classifier labeled a short text as `price_list_full`).
   REQUIRED (user, 2026-09-25): a deterministic pre-filter WITHOUT AI before the
   classifier, so no tokens are spent on obvious messages:
   - contacts of kind `customer` never go to price extraction;
   - stickers, reactions, locations and short messages without numbers or media
     ("hola", "gracias", "ok", emojis only) are classified `other` without calling Claude;
   - only what can be a price list (numbers, currency, or a PDF / image / audio from a
     supplier) goes through the classifier.
   Record how many messages were filtered without AI (in the run report or in
   `ai_usages`) so the dashboard (phase 9) can show the savings.
   Also in the pre-filter (user, 2026-09-25): voice notes longer than 3 minutes are NOT
   transcribed automatically (they stay as media to listen to by hand, with a warning /
   review item); the limit is a Setting (e.g. `transcription.maxAutoDurationSeconds` =
   180). Today the transcription job runs as soon as the audio is stored (phase 4), so the
   check goes there. Verify whether Meta's webhook gives the audio duration; otherwise
   read it from the file (OGG/Opus header) without ffmpeg.

Week 3
7. coexistence human + bot — same number via WhatsApp Business app
   coexistence (verify current availability/requirements in Meta docs,
   including the webhook field for messages the human sends from the app,
   e.g. message echoes). Rules: a human message (from the phone app or from
   the panel) switches the conversation to HUMAN mode; bot reactivates after
   a configurable timeout (scheduled pg-boss job) or manually from the panel.
   Fallback if coexistence is not available for the number: humans reply
   only from the panel.
   REQUIRED (WhatsApp policy, before production): opt-out. Inbound keywords such as
   "STOP", "BAJA" (case/accents-insensitive, configurable list) set
   `Contact.optOutAt`, confirm the opt-out to the user and block every
   business-initiated message (templates) to that contact; opting back in needs an
   explicit new opt-in. Admin panel shows opted-out contacts.
8. admin auth — JWT access + refresh, roles `admin` and `operator`. No OAuth.
   REQUIRED BEFORE PRODUCTION, first sub-step of this phase, before the JWT work (user,
   2026-09-26, found live during the phase 7 phone test): `internal_order` (and any other
   customer/internal message asking for something, not just `customer_query`) must route to
   an actionable notification to the team, exactly like `customer_query` does — today it is
   classified and silently dropped ("otro (fin)" in the receiver), which for a real client
   is a lost order. Backend: extend the notification categories (or generalize
   `customer_query` into a broader "message needs a reply" category) so `/internal/notify`
   accepts `internal_order`; respects the existing anti-spam rules (digest window, hourly
   cap) unchanged. n8n: the receiver's route (`Ruta` node) sends `internal_order` down the
   same branch as `customer_query` to the Notificador sub-workflow — a small, reviewable
   change to `receiver.json`, re-imported/tested/exported by the user like the phase 6
   workflows. Does not depend on JWT or the admin UI: it is backend + n8n routing, so it
   goes BEFORE the auth work, not after.
9. admin UI — Next.js (noindex), real-time via SSE:
   - Dashboard: messages processed, automation rate, errors, per day
   - Catalog: products by supplier, live updates
   - Price history per supplier/product (chart)
   - Conversations: inbox, chat view, who is answering (bot/human) badge,
     pause/activate bot per chat, reply as human
   - Rules (no-code config): price-change alert %, low-stock threshold,
     human-takeover timeout, alert recipients, bot on/off, business hours
   - "Probar el sistema" page (user, 2026-09-25), ONLY in demo mode (the DEMO_MODE of
     phase 12; hidden and its endpoint disabled otherwise): buttons "Enviar foto de lista
     de precios", "Enviar PDF de proveedor", "Enviar audio de proveedor", "Enviar mensaje
     con prompt injection" inject the sample messages into the REAL pipeline (simulated
     signed webhook + fake Graph API + fake LLM serving the golden outputs), so a visitor
     watches the flow live (SSE) up to the catalog and the review queue, without WhatsApp
     and at $0. Rate limited; demo data resettable.
     The demo's sample supplier is SEEDED with its spreadsheet format already approved
     (`supplier_sheet_formats`, user 2026-09-26): new formats always go to review
     (column_mapping), so without the seed the "Enviar planilla" demo would stop at the
     first spreadsheet. The seed shows the fast $0 path; the review flow is shown with a
     second, unseeded format.
   - Richer WhatsApp digest (user, 2026-09-26, after the real test): today it reads
     "SmartOps · 1 consulta de cliente. Detalle en el panel." Add a little context per
     item (who asked / which supplier, a short snippet of the message, the main price
     change) while keeping ONE message per window and the anti-spam caps: few lines, a
     "+N más" overflow, snippets truncated and neutralized. It goes to the team (not a
     customer), but it still must not log bodies (see the logging rules).

Week 4
10. tests — unit: signature check, idempotency, catalog rules, coexistence
    state machine, extraction schema validation (mocked LLM). e2e: webhook
    with fixtures (valid, invalid signature, duplicate delivery), internal
    API auth, ingest full vs partial.
11. CI/CD — GitHub Actions: lint + typecheck + test + build (Postgres
    service container for e2e).
12. deploy config — $0 deploy (see "Cost constraint" and "Deploy target"; ADR
    superseding ADR-007). Option A (preferred): Oracle Cloud Always Free ARM VM with
    the docker compose stack (api, worker, n8n, postgres) + Caddy/Let's Encrypt;
    admin on Vercel Hobby. Option B (fallback): Render free (api + worker in one
    process, demo mode; n8n separate) + Supabase free Postgres (not Neon) + Vercel.
    Verify current free-tier limits before implementing. `prisma migrate deploy` on
    release. Also document the paid deploy for a real client (e.g. Render paid
    instances + managed Postgres) with a monthly cost estimate. Ask before anything
    that could generate charges.
    SECURITY (user, 2026-09-26): the n8n editor must NEVER be publicly exposed — reachable only
    through a tunnel/VPN or an allow-listed IP, on top of the n8n login. Only the webhook paths
    the backend calls may be reachable (and in the single-VM compose they stay internal).
    CHECKLIST (user, 2026-09-27, after the phase 9 phone tests): verify SSE end to end through
    Caddy on the VM (first event in ms, not at the end — Cloudflare held GET streams); the
    PUBLIC demo server must not load ANY real key (Meta, Anthropic, Groq) — DEMO_MODE forces
    fakes, but the keys must not even be present; there must be NO demo admin with a public
    password there (DEMO_ADMIN_PASSWORD unset or secret; only the public operator).
13. docs — README: problem, architecture diagram, flow, setup with Meta test
    number, env var table, demo GIF, cost estimate, ADR list.
    Expanded (user, 2026-09-28): i18n FIRST (panel English by default + Spanish, neutral Spanish),
    then English docs, screenshots / video, panel guide EN + ES, portfolio kit — see Current phase.

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
- Deploy target: $0 custom target (Oracle Cloud Always Free VM + Caddy, or Render free
  + Supabase; admin on Vercel Hobby) instead of `render` — cost constraint of the
  portfolio demo (2026-09-24). ADR in phase 12 (supersedes ADR-007).
- CI/CD tools beyond "GitHub Actions" (phase 11, approved 2026-09-27, ADR-022): Renovate
  (dependency PRs; Dependabot cannot update pnpm 12), gitleaks (secret scanning while private),
  release-please (single version + changelog), Trivy (image OS vulnerabilities), actionlint +
  zizmor (workflow lint). All free, pinned by SHA / digest. Docker images for API and panel
  (GHCR, private while the repo is private).
- Phase 12 deploy tooling (plan approved 2026-09-28; ADR-023 at the phase close): Oracle Cloud
  Always Free (home region São Paulo, Santiago second; A1 VM, Bastion, Object Storage,
  Budgets), Caddy 2.11 (HTTPS + one origin), DuckDNS (free subdomain, reserved IP), age (backup
  encryption, private key only on the owner's PC), OCI CLI container (instance principal
  uploads), Healthchecks.io + UptimeRobot (monitoring), shellcheck in CI. The real WhatsApp
  instance is OUT of phase 12 (the VM only runs the public demo, without real keys).
- Panel i18n (phase 13, plan approved 2026-09-28, ADR-024): next-intl 4.14.7 (exact; App Router
  WITHOUT i18n routing) + eslint-plugin-i18next (`no-literal-string`, M2).
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
- 2026-09-24 (phase 3, M4) Outbound messages (`src/modules/messaging/`): `send()`
  validates content (Zod), the 24h customer service window (text) and opt-in
  (templates), then stores a pending Message + enqueues its job in ONE transaction
  (`fromPrisma`). Worker `whatsapp-outbound` re-checks rules, calls Meta
  (`whatsapp-send.client.ts`: `to` for phones, `recipient` for BSUIDs), stores the
  wamid and backfills statuses that arrived before it (`markAccepted`).
- Window rule (`customer-service-window.ts`): open while now < lastInboundAt + 24h − 2 min
  (safety margin). Error codes `WINDOW_CLOSED` and `OPT_IN_REQUIRED` (409).
- Opt-in (ADR-009): `Contact.optInAt/optInSource` (inbound | manual); implicit inbound
  opt-in set on ingestion + backfilled in migration; CHECK `contacts_opt_in_chk`.
- Order per conversation: queue `whatsapp-outbound` uses pg-boss native
  `key_strict_fifo` with `singletonKey = conversationId` (parallel across
  conversations; verified with real workers). A job in failed state blocks its key, so:
  the FINAL attempt settles the message as failed without throwing, and the DLQ worker
  deletes the failed source job (`sourceId`) to unblock the conversation.
- Meta error mapping (`classifySendError`): 131047 window, 131026/131030 recipient,
  132xxx template, 100/131008/131009/131051 bad request, 190 token, 368/131031 account →
  permanent (Message failed with Meta's code); 130429/131056/131000/5xx/network → retry.
  Once Meta accepted a message the job never throws (a retry would send it twice).
- `Message.idempotencyKey` (unique): repeated sends with the same key return the same
  message (for n8n retries in phase 6).
- 2026-09-24 (phase 4, M1) Speech-to-text (`src/modules/transcription/`): `Transcriber`
  interface; `providers/openai-compatible.ts` (POST {baseUrl}/audio/transcriptions,
  multipart via native FormData/Blob, file named `audio.<ext>` because providers infer
  the format from the extension; `verbose_json` for whisper models, `json` otherwise;
  temperature 0; errors: 400/413/415/422 invalid_audio (permanent), 401/403
  unauthorized, 429 rate_limited (+ retry-after), 5xx/timeout/network transient).
  Accepted as-is: Groq flac/mp3/m4a/ogg/wav/webm; OpenAI the same WITHOUT ogg; nobody
  takes aac/amr. `providers/fake.ts` returns `<TRANSCRIPTION_FAKE_DIR>/<sha256>.txt` or a
  placeholder. Env: `TRANSCRIPTION_PROVIDER` defaults to `fake`; key required unless
  fake; fake rejected in production. Empty env values (`KEY=`) mean unset
  (`optionalString`).
- Versioned prompt files are runtime assets: `scripts/copy-assets.mjs` copies every
  `src/**/prompts/` directory into `dist/` after tsc (build script). The vocabulary
  prompt is validated at load (≤ 800 chars ≈ Whisper's 224-token limit).
- 2026-09-24 (phase 4, M2) Transcription pipeline: `MediaRepository.markStored` runs in a
  transaction and calls `onStoredInTx` only on the pending → stored transition; for
  audio, `createOnAudioStoredInTx` creates the pending `transcriptions` row + enqueues
  `media-transcription` with `fromPrisma(tx)` (a failed enqueue rolls back "stored").
  Service: already done → skip; provider does not accept the format → skipped
  unsupported_format; rolling 24h per-contact quota → skipped quota_exceeded; bytes
  from MediaStorage; invalid_audio → failed; retryable errors throw (queue backoff
  30 s → 15 min, 6 attempts, DLQ → failed retries_exhausted). `markDone` copies the text
  to `Message.transcript` in the same transaction; empty text = done +
  reason empty_transcript. Transcript text is never logged (only its length).
- 2026-09-24 → 2026-09-25 Meta account history: Meta disabled the business portfolio and
  the WABA for "Acceptable Use Policy" (a false positive on a new account); the user
  requested a review, development continued with the local simulator (M2.5) and the
  review was resolved in the user's favor. The test number was re-registered
  (POST /register → CONNECTED, CLOUD_API, AVAILABLE_WITHOUT_REVIEW, quality GREEN), the
  app stayed subscribed to the WABA, and `WHATSAPP_GRAPH_BASE_URL` was removed from the
  local `.env` (real Graph API again). Lesson: keep the simulator as the default dev
  path; real Meta for validation and fixtures only.
- 2026-09-25 (phase 3, M5) What real Meta payloads look like (fixtures README): media
  objects carry a signed `url` (lookaside.fbsbx.com); the WEBHOOK `sha256` is base64
  while the media API (`GET /{media-id}`) returns hex — `sha256Matches` accepts both
  and the simulator mirrors it (`wa:simulate` base64, `wa:fake-graph` hex); statuses
  include `contacts` and `pricing.type`; BSUIDs look like `UY.<16 digits>`; photos
  arrive as image/jpeg without caption unless typed; Meta also sends the `security`
  field (PIN_RESET_SUCCESS) — ignored. Two apps are subscribed to the WABA: ours and
  Meta's "WA DevX Webhook Events 1P App" (dashboard tooling). `wa:fixtures:capture`
  (scripts/fixtures/anonymize-webhook.ts) anonymizes with deterministic fakes and
  refuses to write if any original identifier survives.
- 2026-09-25 (phase 5, M1) AI module (`src/ai/`, ADR-011): features call `AiClient`
  only. Claude via `@anthropic-ai/sdk` 0.128: `output_config.format` json_schema
  (structured outputs, GA) + `output_config.effort` (low classify / medium extract;
  thinking tokens bill as output); system prompt `cache_control: ephemeral` only when it
  reaches the model minimum (Sonnet 5: 1,024 tokens; Haiku 4.5: 4,096); PDF as base64
  `document` block, images as base64 `image` blocks; `maxRetries: 1`; timeout
  `AI_TIMEOUT_MS`. Outputs are always re-validated with Zod (refusal / max_tokens / bad
  JSON / Zod failure → LlmError invalid_output, keeping the billed usage).
  Spend guard: worst-case estimate (text chars/3; image ceil(w/28)*ceil(h/28), max 4784;
  PDF page 4,600) + max_tokens, checked against total / daily (UTC) / per-contact limits
  BEFORE the call; every attempt is an `ai_usages` row (ok | error | budget_blocked).
  Prices in `src/ai/pricing.ts` (verified 2026-09-25: Sonnet 5 $2/$10, Haiku 4.5 $1/$5 per
  MTok; cache write 1.25x, read 0.1x); unpriced models fail at startup. The fake provider
  costs $0, skips the budget check and resolves golden outputs by
  `fakeContentKey(task, content)` (sha256 of the exact content). `AI_PROVIDER` defaults to
  fake; fake is rejected in production. Prompts: `src/ai/prompts/*.md`, version =
  name@sha12. Tests inject `fetch` into the Anthropic SDK: no real calls, no spend.
- 2026-09-25 (phase 5, M4) Catalog ingest + human review (ADR-012). Pure planner
  `planIngestion` decides; `catalog.repository.ts` applies in ONE transaction under advisory
  locks (`catalog:contact:<id>`, `catalog:supplier:<id>`; approvals take the same supplier
  lock). Run lock `extracted → ingesting`; finished runs return the stored report.
  Partial unique index `price_changes_run_product_auto_key` (run, product) WHERE
  source='auto' — hand-written in migration `catalog_ingest`, keep it.
- Supplier resolution (user rule): contact's supplier → else document supplierName matched
  with `normalizeSupplierName` (accents/case/punctuation/legal forms ignored) → else a new
  supplier (supplierName, else WhatsApp profile name, else "Proveedor <masked phone>")
  linked to the contact (kind unknown → supplier), informative warning. >1 match →
  `unknown_supplier` gate. `Supplier.normalizedName` (indexed, not unique).
- Percentage rounding (confirmed by the user 2026-09-25): decimals of the current price, min 2; if the
  effective change deviates > 0.1 pp from the stated %, more decimals up to 4
  (12.5 +7.5 % → 13.44; 0.035 +10 % → 0.0385). `price-math.ts`.
- Settings (confirmed defaults): catalog.maxIncreasePct 50, maxDecreasePct 30,
  priceAlertPct 10 (≥ creates an Alert), lowStockThreshold null, autoCreateProducts true,
  reactivateOnQuote true. Code defaults + DB rows validated per key; invalid stored value →
  default + warn log. Read-only for n8n at `GET /api/v1/internal/rules`.
- Currency missing on a line: assumed only when every product of the supplier has that
  currency (warning currency_assumed); new products without currency → review.
- `Product.priceSourceAt` = WhatsApp timestamp of the message that set the price; an older
  message → `stale_source` review. `Supplier.taxIncluded/taxIncludedAt` = last stated basis.
- Review items (`review_items`): run gates are created by the extraction too
  (`suspicious_instructions`, `extraction_failed` with numbered dedupe keys) and by the
  ingest (`tax_basis_changed`, `unknown_supplier`). Approving tax/suspicious/supplier gates
  re-runs the ingest; extraction_failed only moves the run back (pending/classified) — the
  review never calls the LLM. Stale proposal → superseded + 409 `STALE_REVIEW`. Every
  resolution → AuditLog. Panel routes come in phase 9 (service ready: `review.service.ts`).
- Internal API (`src/modules/internal/`): `X-Internal-Api-Key` (sha256 + timingSafeEqual),
  own limiter `INTERNAL_RATE_LIMIT_MAX` (global limiter skips `/internal/` prefix), strict Zod
  bodies. `INTERNAL_API_KEY` is REQUIRED at startup (min 32) — a random one was generated
  into the local `apps/api/.env` on 2026-09-25.
- 2026-09-25 (phase 5, M3a) Document conversion (ADR-013): `src/modules/documents/`
  (converters, `zip-guard.ts`, `document-converter.ts` worker thread — the .ts worker runs
  through `--import tsx` in dev/tests, the built .js in production). Conversion rejections
  are permanent (no retry); only storage/DB errors are retried. `assertReady` → NOT_READY
  while converting (classify too, like transcription). Failed conversion → run
  `extraction_failed` gate with reason `document_<reason>`, no LLM call. `truncated` or
  `needsReview` (formula without cached value) → forced `partial_update`
  (`applyDocumentRules`); `needsReview` → `StoredExtraction.documentIncomplete` → the
  planner sends every line to review (reason `document_incomplete`).
- Budget: `AI_MAX_RUN_USD` (default 0.30) = per ingestion run (`ai_usages.ingestion_run_id`
  sum), checked with total ($4) and daily ($0.50) caps; reason `run_budget_exceeded`.
- Supply chain: pnpm `minimumReleaseAge` is respected. `pnpm add` auto-added a
  `minimumReleaseAgeExclude` for csv-parse 7.0.3 (published the same day): reverted, pinned
  7.0.2 instead. Never commit a release-age exclusion without asking.
- 2026-09-26 (phase 5, M3c) Spreadsheets (ADR-014): `src/modules/sheets/` — `sheet-values.ts`
  (fingerprint, prices: numeric cells exact; decimal_comma → dots only as thousands groups,
  decimal_dot → commas only as thousands groups, anything else null = never guessed),
  `sheet-reader.ts`, `list-rules.ts`, `sheet-input.ts` (tags `sheet_sample` / `product_names`
  added to the neutralization list), `sheet-extraction.ts`, `sheet-format.repository.ts`.
  `deterministicExtractionSchema` allows 20,000 items (LLM outputs stay capped at 500).
  AiTask `map_columns` / `match`; `LlmContent.cache` = extra cache breakpoint (catalog);
  `AiClient.preflight/estimateUsd` check a whole batch before the first call.
  Supplier resolution shared by ingest and format approval (`supplier-resolution.ts`,
  `CatalogRepository.resolveContactSupplier`). Approving column_mapping never calls the
  LLM: it saves formats and moves the run back to `classified` (`next: "extract"`).
- Local tunnel: cloudflared quick tunnel (`cloudflared tunnel --url
  http://localhost:4000`); URL changes on every restart → update it in Meta.
- 2026-09-26 (phase 7, M1) Human takeover (ADR-016, `src/modules/conversations/`). Pure
  `nextMode` (bot ↔ human, `humanUntil` null = indefinite): human message (panel / app echo)
  → human until now + `coexistence.humanTakeoverMinutes` (Setting, 120), later human messages
  only EXTEND; manual pause/resume; timeout only if humanUntil passed; contact messages never
  change the mode; a late echo older than the last change back to bot is ignored;
  `autoReplyAllowed` = bot AND received ≥ `modeChangedAt`. History table
  `conversation_mode_changes` (append-only, actor user or label, message). Migration
  `conversation_modes`: `Conversation.modeChangedAt`, `Message.purpose`
  (auto_reply | compliance | team_notification | human; CHECK `messages_purpose_chk`
  outbound ⇔ purpose — keep it), `Message.claimedAt`, status `canceled`.
- Race rules: takeover = ONE transaction under the conversation row lock (mode + history +
  cancel pending UNCLAIMED auto_reply → canceled/human_takeover + reactivation job via
  fromPrisma). The outbound worker claims under the same lock right before Meta
  (`OutboundRepository.claimForSend`): auto_reply in human mode → canceled. Claimed = in
  flight, never cancelled. `send()` refuses auto_reply in human mode (409 `HUMAN_MODE`);
  `purpose` defaults from author (human → human, else auto_reply); digests pass
  team_notification. Queue `conversation-bot-resume` (startAfter = humanUntil; stale jobs
  no-op) + cron `conversation-mode-sweeper` */5. CLI `wa:conversation status|pause|resume`
  (actor `cli:<--by>`).
- 2026-09-27 (phase 11) CI/CD (ADR-022, `docs/ci-cd.md`). GitHub Free + private repo → no
  branch protection / rulesets, CodeQL, GitHub secret scanning, dependency-review or
  attestations API; free substitutes instead. Workflows: `ci.yml` (`quick` on every push:
  actionlint + zizmor `--offline`, gitleaks on new commits, audit gate, format, lint,
  typecheck, test:fast; `plan` → `integration-coverage` (Postgres service, coverage ratchet =
  gate, build), `e2e` (per `E2E_POLICY`, browsers installed every run, no cache), `images`
  (only when Docker inputs change); `main-guard` on push to main (commit must belong to a merged
  PR); nightly 06:00 UTC = 03:00 Montevideo only with new commits), `release.yml`
  (release-please + images), `security.yml` (weekly full-history gitleaks + audit).
  Every action pinned by full SHA (version comment), tool images `image:tag@sha256` (Renovate
  regex manager), `permissions: {}` + minimum per job, `persist-credentials: false`, values into
  `run:` only through `env:`, no Actions cache in release.yml.
- Guards in CI: `claude-md.test.ts` and `coverage-thresholds.test.ts` compare with
  `origin/<base>` and THROW if it is missing (checkout fetch-depth 0).
- gitleaks: `.gitleaks.toml` extends the default rules; allowlists are exact path + value pairs
  (condition AND) — never a folder. Full history scanned 2026-09-27: 74 commits, only 3 fake test
  constants (allowlisted); phone-like numbers in the history are invented (user confirmed).
- Audit gate `apps/api/scripts/security/audit-gate.ts` (`pnpm audit --prod --json`, runs with
  Node's type stripping, no install): HIGH/CRITICAL block unless in
  `security/audit-exceptions.json` (GHSA + package + reason + expires; expired → blocks again).
- Renovate (`renovate.json`): Mondays before 06:00 Montevideo, minimumReleaseAge 3 days (1 for
  vulnerability alerts), grouped non-major, majors disabled for prisma, eslint, next,
  eslint-config-next, react, react-dom and the node / postgres images; lock file maintenance
  monthly. Dependabot = alerts only.
- Local pre-push hook `scripts/git-hooks/pre-push` (`pnpm hooks:install` sets core.hooksPath):
  refuses pushes to main unless `ALLOW_PUSH_TO_MAIN=1`.
- Docker: root `.dockerignore` (no .env*, .sim, .git, docs, n8n, CLAUDE.md). `apps/api/Dockerfile`:
  node 24.21 bookworm-slim by digest, `pnpm fetch` + offline install + `pnpm deploy --prod`
  (`prisma` moved to dependencies), non-root, HEALTHCHECK via Node fetch; ONE image, three
  commands (server default, `node dist/worker.js`, `node node_modules/prisma/build/index.js
  migrate deploy`). `apps/admin/Dockerfile`: `NEXT_OUTPUT=standalone` (only there: Windows
  cannot build standalone without symlink rights), `NEXT_PUBLIC_API_BASE` build arg (default
  /api/v1). `scripts/ci/image-secrets-check.sh` (image Env names, .env / keys / .sim anywhere,
  gitleaks over the app files with `gitleaks-image.toml`: Next's per-build preview/encryption
  keys allowlisted — the panel uses neither "use server" nor draft mode, guarded by
  `apps/admin/test/next-build-keys.test.ts`), `api-container-smoke.sh` (DEMO_MODE + fake values:
  migrations, health, SIGTERM exit 0 for API and worker), `admin-container-smoke.sh`, Trivy
  (OS packages, fixable HIGH/CRITICAL).
- Releases: release-please (`release-please-config.json`, root package only, tags `vX.Y.Z`,
  bootstrap ad17cef, `extra-files` bump both apps; guard `test/unit/release-config.test.ts`:
  versions in lockstep, NO `release-as` in the config). First release forced to 0.11.0 by a
  `Release-As: 0.11.0` commit body. LESSON (2026-09-28): the first attempt was an EMPTY commit
  and GitHub's rebase-merge DROPS empty commits → release-please proposed 0.1.1; `Release-As`
  must go in a commit that changes files (redone in the `fix/release-as-0.11.0` docs PR).
  CHANGELOG heading
  `[Before v0.11.0]` matches release-please's header regex (entries go above it). CHANGELOG.md
  and the manifest are prettier-ignored. Images: native amd64 (`ubuntu-24.04`) + arm64
  (`ubuntu-24.04-arm`) → local build → secrets check + smoke + Trivy → push by digest (same
  builder, SBOM + provenance max) → `imagetools create` tags X.Y.Z, X.Y, sha-xxxxxxx (no latest).
  `ghcr.io/sanchezign/smartops-{api,admin}`.

## Current phase
**Phase 11 (CI/CD) COMPLETE (2026-09-28): v0.11.0 released. Phase 12 (deploy $0, branch
`feat/phase-12-deploy`): M0 DONE; M1 done up to DuckDNS — the VM cannot be created yet (São Paulo
has no A1 capacity). WAITING: the user runs `scripts/oci/launch-retry.ps1` for 3–5 days
(guide `docs/deploy/m1-retry-launch.md`). Phase 13 (i18n + docs, branch `feat/phase-13-i18n-docs`)
advances meanwhile: M0 + M1 DONE, next M2 (panel texts). If the VM appears first, phase 12 does
not wait (first deploy without i18n, updated later). M3b (phase 5) and MFA (TOTP) remain
recommended/required before a real client.**

1. scaffold — done (2026-09-24).
2. config/env/logging + initial Prisma schema — done (2026-09-24). Migrations:
   `init`, `price_change_rules`.
3. core integration (WhatsApp Cloud API) — DONE (M1–M4 2026-09-24, M5 2026-09-25).
   Branches `feat/phase-3-whatsapp` (M1–M4) and `feat/phase-3-m5-real-fixtures` (M5).
   - M1 webhook verify + signed capture + status diagnostics — done. Checkpoint: real
     Meta webhook verified (signed test event stored once; wa:subscribe subscribed the
     app to the WABA). Meta then disabled the portfolio + WABA (resolved, see
     Architecture decisions) → M2–M4 were developed against a local simulator.
   - M2 pg-boss queue + worker + idempotent persistence — done. Migration `whatsapp_worker`.
   - M2.5 local WhatsApp simulator (`wa:simulate` + `wa:fake-graph`) — done.
   - M3 media download + storage (ADR-008) — done. Migration `media_storage`.
   - M4 outbound messages + 24h window + opt-in (ADR-009) — done. Migration
     `outbound_messages`.
   - M5 real traffic + real anonymized fixtures — done (2026-09-25). Real test number
     via cloudflared: text, photo, PDF and voice note from the user's phone + hello_world
     from the Meta panel → all processed on the 1st attempt (media stored, voice note
     transcribed by Groq: 6.82 s audio, 459 ms), template statuses sent → delivered →
     read. Retried/old deliveries: none arrived twice. Fixtures replaced with anonymized
     captures (`wa:fixtures:capture`); extraction test data for phase 5 in
     `apps/api/test/fixtures/extraction/`. The M1 "failed status" code never appeared
     (after the account was restored the template was delivered).
4. media normalization (Whisper for voice notes) — DONE (2026-09-24), merged to `main`. Branch
   `feat/phase-4-media-normalization`. Approved plan: Groq whisper-large-v3 free plan
   (ADR-010), AAC/AMR skipped (unsupported_format), `transcriptions` table + copy in
   Message.transcript, daily per-contact limit (50), fake provider, vocabulary prompt.
   - M1 Transcriber interface + OpenAI-compatible provider (Groq/OpenAI) + fake + env
     + ADR-010 — done (2026-09-24).
   - M2 transcription job (atomic enqueue on media stored), `transcriptions` table,
     per-contact quota, onTranscribed hook, `wa:transcription:retry`,
     `wa:simulate audio --transcript` — done (2026-09-24), tested with the simulator +
     fake transcriber. Migration `transcriptions`.
   - Real test with Groq (free plan, Global ZDR enabled) — done (2026-09-24): a real
     7.42 s OGG/Opus voice note went through the full pipeline (simulated webhook →
     fake Graph download → transcription job → Groq whisper-large-v3) → done in 665 ms,
     1 attempt, language Spanish, text copied to Message.transcript. Local
     `apps/api/.env` now uses `TRANSCRIPTION_PROVIDER=groq` (simulated audio also hits
     Groq's free quota; switch back to `fake` for heavy local testing).
   - Next: phase 5 (extraction + catalog).
5. extraction + catalog — DONE (2026-09-26): M1, M2, M4, M3a, M3c. M3b (chunked extraction of
   long PDFs/docx) stays as a REQUIREMENT BEFORE PRODUCTION (see below). Merged to `main`. Branch `feat/phase-5-extraction-catalog`.
   Approved plan (2026-09-25) + user changes: catalog matching (exact normalized match →
   Claude `matchedProductId` + confidence → ambiguous = needs_review, never a silent
   duplicate; the PDF → photo e2e test must detect all 6 price changes); `full_list`
   only with an explicit signal in the document (default `partial_update`); marking
   products unavailable = alertCandidate for review (never applied automatically in the
   MVP); `/internal/extract` locked per run (status `extracting`; a concurrent request
   gets the existing result or 409 IN_PROGRESS; concurrency test); prompt injection
   (documents are data; malicious fixture + test; ADR-011). Ask the user (with the
   estimated cost) before ANY real Claude spend (golden recording, manual run).
   - M1 `ai/` module: LlmProvider (anthropic via @anthropic-ai/sdk 0.128, fake), AiClient
     with spend guard, `ai_usages` ledger, IngestionRun cost fields, pricing table,
     versioned prompt loader, AI_* env, ADR-011 — done (2026-09-25). Migration `ai_usage`.
   - M2 classification + extraction — DONE (2026-09-25). First part (WIP
     commit a755713): classification/extraction JSON schemas + Zod
     (`src/modules/extraction/extraction.schemas.ts`) and post-rules (full_list needs
     quoted evidence, unknown refs dropped, duplicate refs → medium); catalog context with
     stable refs P1..Pn (`catalog-context.ts`); message input with neutralized tags
     (`message-input.ts`); fake responders; ingestion repository + service (classify;
     extract locked via status `extracting`; NOT_READY / IN_PROGRESS; budget →
     needs_review; injection → needs_review); migration `ingestion_extracting`;
     `ai:record-golden` script (`--dry-run` uses the FREE count_tokens endpoint;
     `--confirm-spend` records); fixtures `voice-transcript.txt`, `injection-message.txt`.
     Golden keys = message content only (`fakeKeyText`), not catalog/sender context.
   - M2 user changes — done (2026-09-25), prompts now classifier@5814260d7fc5 and
     extractor@32d8d0e8e78d:
     1. Neutral examples (silicona, clavo, manguera, disco de corte, rodillo, taladro) in
        BOTH prompts; `test/unit/prompts.test.ts` fails if a product of
        `test/fixtures/extraction/expected.json` (`productNames`) appears in
        `src/ai/prompts/*.md` — full name or head noun, singular/plural (verified to fail
        on the old prompts). The Whisper vocabulary prompt is out of scope on purpose.
     2. Missing distinguishing attribute → max "medium": prompt rule + code safety net
        (`src/modules/catalog/attributes.ts`: sizes/measures/capacities canonicalized,
        "4 litros" = "4L"; applied in `applyExtractionRules`, which now receives
        catalogRef → product name, `CatalogContext.refNames`). A different size is also
        capped. PDF → photo expectations reconciled in `expected.json`
        (`photoAgainstSeptember`): 5 automatic price changes, "Arandela" vs
        "Arandela 6mm" = review item, Pintura untouched.
     3. Percentages: item `price` XOR `priceChangePct` (signed plain decimal, ≠ 0,
        > -100, ≤ 2 decimals; enforced by Zod) + list-level `globalChangePct`
        ("todo +8%", nulled when not a price list). The prompt forbids computing prices
        from the catalog; changes by an amount ("sube 20 pesos") → no item + warning;
        group percentages → one item per catalog product, max "medium".
     4. `taxIncluded` (boolean | null) at list level, stored in
        `ingestion_runs.raw_extraction` (no migration).
   - Goldens v1 (`test/fixtures/extraction/golden/`, 3 classify + 4 extract): dry-run expected
     $0.1196 / worst $0.3193 (within the authorized caps) → recorded, REAL COST $0.0554
     (ledger: 7 `ok` rows, $0.055409; extractor prompt cached: 4,384 tokens written once
     and read 3 times). `test/unit/golden-outputs.test.ts` checks them against
     `expected.json`. Reviewed by the user: all 7 correct (prices, units, catalogRefs).
   - Round 2 (user, 2026-09-25) — done except the re-recording: Security and ASR examples
     neutralized in both prompts (no paraphrase of `injection-message.txt`, no "de lunas";
     prompts now classifier@6261a4d6a9e6, extractor@e5fecb026a39); `prompts.test.ts` also
     fails on any 3-word sequence of the text fixtures or a curated phrase/paraphrase
     (`expected.json` → `fixturePhrases`); deterministic rule in `applyExtractionRules`:
     empty catalog → every item `catalogRef=null, high`. 516 tests green.
     Goldens v2: dry-run expected $0.1198 / worst $0.3195, recorded with the user's
     explicit OK → REAL COST $0.0557 (M2 total real spend: $0.1111). Diff vs v1: same
     prices, catalogRefs, Arandela medium, injection detected; PDF items now `high`
     (matches the empty-catalog rule); the short text is now `price_update_partial`
     (0.55); the voice note no longer reads "de lunas" as "desde el lunes" (price 14
     kept, validity lost, still uncertain); the photo lost its "Octubre" warning.
   - Order decided by the user (2026-09-25): M3a → M3c → M3b.
   - M3a document conversion — DONE (2026-09-25), ADR-013. xlsx/xls (SheetJS 0.20.3 from
     the CDN), csv/txt (csv-parse 7.0.2), docx (mammoth 1.12.3 + htmlparser2) → Markdown in
     `document_conversions` (migration `document_conversions`), job `document-conversion`
     enqueued with the media-stored transaction, isolated worker thread (heap 256 MB,
     timeout 20 s) + ZIP guard; `GET /api/v1/internal/runs/:id`; `AI_MAX_RUN_USD` ($0.30).
     Converted documents with > 30 product lines → review `requires_chunked_extraction`
     (never half a list). 609 tests green. $0 spent.
   - M3c spreadsheet formats — DONE (2026-09-26), ADR-014. Typed tables in
     `document_conversions.tables`; `supplier_sheet_formats` (migration `sheet_formats`,
     partial unique index: one ACTIVE per supplier + header fingerprint; formats coexist;
     failing > 20 % of rows → retired, never deleted, re-mapped); mapper prompt
     `column-mapper.md` (1 call per new format, always → review `column_mapping`; several
     price columns → ambiguous, the reviewer must choose; the chosen column sets
     taxIncluded); compact matcher `matcher.md` (only non-exact names, batches of 150,
     cached catalog block, untrusted `<product_names>`, output row/ref/confidence validated
     against the rows and refs sent; all batches preflighted against the budgets);
     deterministic list signals (tax, currency, quoted full-list evidence, injection);
     batched catalog writes (2,000 rows read + ingested in ~1.5 s). Fixtures
     `test/fixtures/sheets/precios-multiples*.xlsx` (script `scripts/fixtures/build-sheet-fixtures.ts`,
     products registered in expected.json so prompts never quote them). 654+ tests green.
     Sheet goldens recorded with the user OK (dry-run $0.0143 / worst $0.0990) → REAL COST
     $0.0141: mapper found header R2, name C1, SKU C0, unit C2 and the 4 price columns
     (s/IVA false, c/IVA true, Mayorista, Contado → ambiguous; recommended C4; UYU;
     supplier "DISTRIBUIDORA EJEMPLO S.R.L."); matcher: "Tanza para bordeadora 2mm" → new
     product (ref null, high). Checked in golden-outputs.test.ts. Total real AI spend so far:
     $0.1111 (M2) + $0.0141 (M3c) = $0.1252.
   - M3b chunked extraction — REQUIRED BEFORE PRODUCTION / a real client (user,
     2026-09-25): split long PDFs and docx (and any text document not covered by M3c) into
     blocks with the catalog as context; merge before the ingest; full_list and missing
     products decided only after merging; one failed block → the whole run to review;
     spend cap checks ALL blocks before the first call (+ AI_MAX_RUN_USD); dedupe items
     across blocks; async (202 + GET /internal/runs/:id). Open for its plan: PDF page
     splitting with @cantoo/pdf-lib vs cached whole PDF + page ranges, and max_tokens
     12,000 for 1-page PDF blocks. Measured: ~95 output tokens per typical item, 132 with a
     note, 169 worst → safe block = 25 rows with max_tokens 6,000; ~$0.001 per product.
   - M4 catalog ingest + human review — DONE (2026-09-25), ADR-012. Commits: step 1 pure
     planner (`ingest-plan.ts`, `price-math.ts`, `supplier-name.ts`, settings schemas),
     step 2 migration `catalog_ingest` + `catalog.repository.ts`, `catalog-ingest.service.ts`,
     `src/modules/reviews/`, `src/modules/settings/`, step 3 internal API
     (`src/modules/internal/`, `INTERNAL_API_KEY`) + e2e. 576 tests green. $0 spent.
     E2E over HTTP with the goldens (`test/integration/catalog-e2e.test.ts`): September PDF
     creates the supplier "Distribuidora Demo S.A." (taxIncluded true) + 7 products; the
     October photo → 5 automatic changes (16.6667 / 20 / 6.6667 / 4.1667 / 2.381 %), 2
     alerts (Tornillo, Tuerca), Arandela → product_match review, Pintura untouched,
     warning tax_not_stated; voice note → uncertain_value; injection → suspicious gate.
   - Facts from the test data: September PDF (7 products, UYU, IVA incluido) → October
     photo (UYU, tax not stated): 6 products match (3 exact, 3 need the model; the model
     writes "Cable 2mm" + unit "metro", which is then an exact name match), 5 automatic
     price changes, Arandela → review (price 3 unchanged), Pintura absent (partial update
     → untouched).
6. n8n multi-agent — DONE (2026-09-26), merged to `main`. Branch `feat/phase-6-n8n`.
   Approved plan (2026-09-26) + user answers: customer contacts →
   deterministic `customer_query` (no LLM); demo notifications = panel + WhatsApp to the
   user's own number via the test number (no new accounts); supplier acknowledgement
   implemented but OFF by default (Setting; ON in demo mode); delivery to n8n retried for
   ~24 h (intervals up to 1 h) → failed + alert + manual replay. ANTI-SPAM (user): notify
   only actionable events (increases over the threshold, low stock, pending reviews,
   customer queries, integration errors); a run without news does not notify (panel only);
   per-recipient digest window (default 10 min) → one message; per-recipient hourly cap
   (Setting), excess goes to the next digest; critical errors may skip the digest with
   their own cap. Stop at M4 so the user imports and tests the workflows.
   - M1 pre-filter + audio cap — DONE (2026-09-26). `src/modules/extraction/prefilter.ts`
     runs INSIDE classify() (after the pending checks, before the LLM); rules
     customer_contact (→ customer_query), non_content_type, media_unavailable,
     audio_too_long, audio_not_transcribed, no_price_signal (text/transcript without digits,
     currency or price/stock words); stored in `ingestion_runs.prefilter_rule` (indexed,
     migration `prefilter`) for the dashboard; extract refuses pre-filtered runs and
     customer contacts (409). Audio cap: Setting `transcription.maxAutoDurationSeconds`
     (180), duration read from the file (`media/audio-duration.ts`: OGG/Opus last granule −
     pre-skip at 48 kHz; MP4 mvhd; unknown → > 3 MB is long) → transcription skipped
     `too_long` + Alert `manual_attention` (new AlertType) in one transaction.
   - M2 outbox + delivery to n8n — DONE (2026-09-26). Closes the phase 3 known issue.
     `integration_events` (migration `integration_events`, dedupeKey unique
     "message.ready:<messageId>", payload = ids/routing only, never content) written by
     `createEmitMessageReadyInTx` in the transaction of each readiness point: ingest (no
     pending media), media stored image/PDF (`createOnReadyMediaStoredInTx`), media final
     (rejected/failed/skipped), transcription done/final/too_long, conversion done/failed;
     its pg-boss job `n8n-delivery` is enqueued in the same transaction. Delivery: POST to
     `N8N_RECEIVER_WEBHOOK_URL` with header X-SmartOps-Secret (`N8N_WEBHOOK_SECRET`), 2xx →
     delivered; else retry 30 s doubling to 1 h, retryLimit 30 (≈ 24 h), DLQ → failed +
     critical `integration_error` alert (new AlertType); `pnpm n8n:replay` re-sends failed.
     Watchdog cron */5: pending untouched > 2 h → re-enqueue; delivered > 15 min without an
     ingestion run → redeliver (max 2). `N8N_DELIVERY_ENABLED` (default false: events
     accumulate). The old post-commit onInboundMessage hook is now log-only.
   - M3 notifier endpoints + anti-spam notifications — DONE (2026-09-26). Internal API adds
     POST /notifications {kind: run|customer_query|manual_attention}, POST /n8n/errors (error
     workflow → critical integration_error alert + notification), POST /messages/ack {runId}
     (Setting `bot.supplierAck`, default false, ON in demo mode; text composed by the backend
     from the run report; only suppliers, only conversation mode bot, idempotencyKey
     ack:<runId>). Tables `notification_items` (recipient "panel" or a team waId, unique
     (recipient, dedupeKey)) + `notification_digests` (migration `notifications`). Rules
     (`notifications/digest-rules.ts`): a run notifies only with increases ≥
     catalog.priceAlertPct, low stock or pending reviews (small increases → panel only);
     WhatsApp recipients (`notifications.whatsappRecipients`, waIds with opt-in) get ONE
     digest per window (`notifications.digestWindowMinutes` 10, job `notification-digest`
     scheduled with startAfter in the recording transaction), capped by
     `notifications.maxPerHour` (4; excess postpones the digest, items keep joining it);
     critical items skip the window under `notifications.criticalMaxPerHour` (3). Digest send
     (worker): text if the 24 h window is open, else `notifications.template` (utility, one
     body param) with opt-in, else panel_only. Contract test with a fake n8n orchestrator
     (`test/integration/n8n-contract.test.ts`): outbox → secret-checked webhook → classify →
     extract → ingest → runs/:id → notifications → ack over HTTP; duplicates harmless.
   - M4 workflows — DONE (2026-09-26). Drafts delivered (commit 5137f67); the user imported
     them into n8n 2.40.6 (the drafted node typeVersions worked as-is), chose credentials and
     sub-workflows, tested, published and exported them with `n8n:export` (commit 55de4e9).
     `n8n/workflows/{receiver,processor,notifier,errors}.json` = "SmartOps · Receptor /
     Procesador / Notificador / Errores" (webhook v2 Header Auth "SmartOps webhook secret",
     respond immediately; HTTP Request v4.2 with Header Auth "SmartOps API", retry 3×5 s;
     Config Set node with apiBaseUrl — no $env; sub-workflows via Execute Workflow; the
     processor polls runs/:id while "extracting" (max 30); error workflow →
     /internal/n8n/errors). Setup guide: docs/n8n-setup.md. `n8n:export` = export inside the
     container + sanitizer (`scripts/n8n/sanitize.ts`: drops pinData/staticData/meta,
     credentials as references, fails on anything secret-like or a literal auth header).
     Static tests `test/unit/n8n-workflows.test.ts` (routes exist, credentials by name, no
     secrets, no pinData, no classification-based full/partial in processor/notifier; the
     webhook's default responseMode is omitted by the export and accepted). docker-compose:
     n8n `extra_hosts host.docker.internal:host-gateway`. Workflows must be PUBLISHED (n8n 2.x)
     or the production webhook answers 404 — the outbox retries delivered the pending events
     by themselves once they were published.
   - M5 validation + docs — DONE (2026-09-26). ADR-015, README section "Orquestación con n8n",
     this file. Local `apps/api/.env`: N8N_DELIVERY_ENABLED=true (AI_PROVIDER back to fake).
     - Real Claude pass (user OK after dry-run: expected $0.1342 / worst $0.4186; cap $0.20),
       simulator + fake Graph, fake transcriber, real Claude. REAL COST $0.0655:
       1. supplier text (2 products) → price_update_partial, 2 created — $0.0171;
       2. "hola" → other, prefilter no_price_signal — $0;
       3. customer contact query → customer_query (prefilter customer_contact) + panel
          notification — $0;
       4. September PDF → 7 created (media skip the classifier: the extraction decides) —
          $0.0135; October photo → 5 changes, 1 review (Arandela without size), 2 alerts
          (Tornillo +16.67 %, Tuerca +20 %) + panel notification — $0.0120;
       5. voice note (fake transcript with the ASR error "de lunas") → item uncertain →
          review, not applied — $0.0086;
       6. new spreadsheet format → mapper $0.0109 → column_mapping review → approved with
          priceColumn 4 ("Precio c/IVA", format saved) → extract + ingest by hand (see Known
          issues) → 7 created, $0;
       7. December spreadsheet, same supplier → no mapper, matcher only for the new product
          ($0.0034) → 1 created, 2 updated, 5 unchanged; no notification (increases < 10 %).
       All 8 events delivered on the 1st attempt, 0 integration errors.
       Total real AI spend of the project so far: $0.1252 + $0.0655 = $0.1907.
     - Real WhatsApp digest (real Graph, cloudflared tunnel, the user's phone): user's
       contact temporarily `customer` and digest window 1 min (both restored afterwards) →
       message "Hola tenes candados 40mm ??" → customer_query without LLM → digest sent as
       TEXT (24 h window open) at 02:14:44 UTC → read on the phone ("SmartOps · 1 consulta
       de cliente. Detalle en el panel."). `notifications.whatsappRecipients` with the user's
       number stays ONLY in the local DB (demo), never committed.
     - Resilience (the user ran docker stop/start): R1 n8n stopped → message acked 200 →
       event pending, 3 failed attempts ("n8n unreachable: fetch failed", 30 s → 60 s) →
       n8n started → delivered on the next retry, 1 run, 0 alerts. R2 2 messages with n8n
       down + 2 right after the start → all 4 delivered, 1 run each, 0 failed, 0 alerts.
       Lesson: a `docker compose stop n8n` run from another folder/context hit nothing — use
       `docker stop smartops-n8n-1` and check the container's StartedAt. The watchdog
       ("delivered without a run", 15 min) was skipped by the user (covered by integration
       tests).
   - Process note: the M3 commit accidentally truncated this file (phases 1–5 history, Known
     issues, Conventions); restored from the M2 version in M5.

7. coexistence human + bot + opt-out — DONE (2026-09-26), merged to `main`. Branch
   `feat/phase-7-coexistence`. Approved plan
   (2026-09-26) + user answers: real coexistence is NOT testable with the Meta test number
   (needs a number already in the WhatsApp Business app + Embedded Signup by a Tech Provider /
   Solution Partner) → demo plan B: humans reply from the panel (phase 9; CLI `wa:reply` until
   then) and app echoes (`smb_message_echoes`) are tested with the simulator + doc-based
   fixtures; real path for a client in `docs/coexistence-client-guide.md` (A: API-only number
   + panel replies; B: coexistence via a BSP that is a Tech Provider, e.g. 360dialog, or
   becoming one — costs verified, else "a confirmar"). Human mode pauses ONLY automatic
   replies (ADR-016). Takeover timeout default 120 min. Opt-out: deterministic keywords (no
   LLM), blocks every message we SEND (bot, templates, digests) except the single compliance
   confirmation; a person may still reply from the panel inside the window with a visible
   warning; an opted-out supplier's lists are STILL processed and update the catalog (no ack)
   — explicit in ADR-017 + tests. Opt-out instruction in the first automatic message to each
   contact, then at most every 30 days. Echo media: metadata only. $0. 4 milestones with
   commit + push; stop at M4 to guide the user's phone tests.
   - M1 state machine + human takeover — DONE (2026-09-26). ADR-016, migration
     `conversation_modes`, `src/modules/conversations/`, claim gate in the outbound worker,
     ack uses `autoReplyAllowed`, resume job + sweeper, `wa:conversation`, CLAUDE.md guard
     test (`test/unit/claude-md.test.ts` + `test/fixtures/claude-md-baseline.json`, raised
     only UP by `pnpm --filter @smartops/api claude-md:baseline`; verified to fail on the
     truncated phase 6 M3 version).
   - M2 echoes + human reply — DONE (2026-09-26). Migration `message_echoes`
     (`Message.revokedAt/editedAt`). Webhook field `smb_message_echoes` parsed
     (`whatsappEchoSchema`, `ParsedEcho`: kind message | revoke | edit, `to` is always a
     phone per Meta's reference — no BSUID in echoes). `WhatsAppIngestRepository.ingestEcho`
     (idempotent by wamid): a "message" echo creates the contact if new (NO opt-in — WE
     wrote first), stores it as an OUTBOUND `Message` (author human, purpose human, status
     sent, media METADATA ONLY — echo media is never downloaded, per the approved plan) and
     calls `onHumanMessageInTx` (human takeover) in the SAME transaction; `revoke` sets
     `revokedAt` on the original; `edit` updates `text`/`editedAt` and appends to
     `raw.edits` (previous text kept). Echoes never reach the classify/extract pipeline
     (no `message.ready` emitted) and never enter `messagesCreated` — separate counter
     `echoesStored`. `src/modules/conversations/human-reply.service.ts` (`wa:reply`): queues
     the person's text first (24h window enforced there — no takeover if it cannot be
     sent), then applies the takeover with the queued message linked in
     `conversation_mode_changes`. Simulator: `wa:simulate echo --to <phone>
     --text|--image|--revoke|--edit`; 4 doc-based fixtures
     (`test/fixtures/whatsapp/echo-*.json`, our real test number cannot use coexistence —
     see phase 7 plan — so these are built from Meta's `smb_message_echoes` reference, not
     captured).
   - M3 opt-out — DONE (2026-09-26). ADR-017, migration `opt_out`
     (`Contact.optOutAt/optOutSource/optOutInstructionSentAt/marketingOptOutAt`, CHECK
     `contacts_opt_out_chk`; `ContactConsentEvent` append-only; `AlertType.possible_opt_out`).
     `src/modules/optout/optout-detector.ts` (pure, NO LLM): whole-message keyword match
     (`optOut.keywords`/`optIn.keywords` Settings, filler words "por favor"/"gracias"
     stripped) or one of a fixed set of explicit short phrases (≤ 12 words); a second,
     looser phrase set → `possible_opt_out` Alert instead of auto-applying. Detected in the
     WORKER at ingestion (`createOnComplianceMessageInTx`, called from
     `WhatsAppIngestRepository.ingestOnce` in the SAME transaction as the inbound message —
     works even if n8n is down), never in n8n or the extraction pre-filter. Effect: gated at
     `OutboundRepository`/`OutboundService` by `Message.purpose` — opted-out contacts block
     `auto_reply`, templates and `team_notification`, but NOT `compliance` (the one
     confirmation reply, queued in the same transaction via the new
     `OutboundRepository.createOutboundInTx`) nor `human` (a person may still reply inside
     the window). Checked twice: `send()` and again in `processOutbound()` (a contact may
     opt out while queued) → error code `OPTED_OUT` (409) / job reason `opted_out`.
     Independent of `Contact.optInAt` (ADR-009): an inbound message never clears an
     opt-out; re-enabling needs `ALTA`/`START` or `wa:optout in` (off-WhatsApp, `--reason`
     required). **An opted-out supplier's lists are still ingested and update the catalog**
     — only `supplier-ack.ts` skips (`reason: "opted_out"`); the digest also falls back to
     `panel_only` for an opted-out team member. Opt-out instruction footer
     ("Respondé BAJA…") appended to the first `auto_reply` text and at most every
     `optOut.instructionReminderDays` (30) after that — checked/set atomically inside
     `createOutboundInTx`'s own transaction (no double-append under concurrent sends).
     `user_preferences` webhook parsed (informational only: `Contact.marketingOptOutAt`;
     Meta error `131050` mapped to a new permanent `recipient_opted_out` category — we send
     no marketing messages, so nothing else reacts to it yet). CLI
     `pnpm --filter @smartops/api wa:optout status|out|in`.
   - M4 client docs — DONE (2026-09-26). `docs/coexistence-client-guide.md`: path A
     (dedicated API number, panel replies, no Tech Provider needed) vs. path B (real
     coexistence via a BSP that is already a Tech Provider, e.g. 360dialog from ~€49/month,
     or becoming one directly — business verification + app review, cost to confirm);
     explains why the demo cannot exercise path B and what to capture/replace
     (`wa:fixtures:capture`) before a real client goes live on it.
   - Real phone test (user's own number, real test number) — DONE (2026-09-26): BAJA →
     opt_out recorded (source keyword, keyword "baja") + confirmation delivered/read; ALTA →
     opt_in recorded + confirmation delivered/read; manual pause (`wa:conversation pause`,
     2 min) → mode human; `wa:reply` → message delivered/read, EXTENDED the pause to the
     default 120 min (a human message always extends to now + humanTakeoverMinutes — the
     2 min manual pause was superseded, as designed); `wa:conversation resume` → mode bot.
     All verified in the DB. Also surfaced: a real order ("necesito 3 macetas") classified
     `internal_order` produced no notification — promoted to a required pre-phase-8 step
     (see Phase order), not merely a known issue anymore.
8. admin auth — DONE (2026-09-26), merged to `main`. Branch `feat/phase-8-admin-auth`.
   Approved plan (2026-09-27) + user
   answers:
   - Deploy for the demo: **option D** (recommended) = everything on the Oracle VM behind
     Caddy, REAL same origin (`/` → Next.js panel, `/api` → API), refresh cookie
     `SameSite=Strict`, SSE direct, real client IP, $0 with a free subdomain + Caddy HTTPS.
     Option A (Vercel rewrite, same origin through a proxy) = alternative if phase 12 ends on
     plan B (Render). Option B (own domain, same site) documented for clients. Option C
     (cross-site, `SameSite=None; Partitioned`) supported but fragile (Safari). The code
     supports every mode through env (`AUTH_COOKIE_SAMESITE/SECURE/PARTITIONED`).
   - Tokens: access JWT HS256 (`jose`) 15 min in panel MEMORY (Bearer); refresh = opaque
     256-bit value, stored as SHA-256, HttpOnly cookie `Path=/api/v1/auth`; rotation on every
     refresh; reuse of a rotated token revokes the whole session (RFC 9700), except a 10 s
     grace for the rotated-just-now token (409 `REFRESH_RACE`, tabs serialize with Web Locks).
     Session: 24 h idle, 7 days absolute. Every request re-reads session + user (logout-all,
     role change and deactivation apply instantly). CSRF on the cookie routes (login,
     refresh, logout): custom header `X-SmartOps-CSRF` + Origin allowlist (+ SameSite,
     + reject `Sec-Fetch-Site: cross-site` in same-origin modes).
   - Passwords: Argon2id via Node's built-in `crypto.argon2` (stable since Node 24.19 →
     `engines >=24.19`), OWASP minimum m=19 MiB, t=2, p=1, PHC string (rehash on login when
     params are weaker). Policy: 15–128 chars, no composition rules, NFKC, blocked: offline
     common-password list + email/name (HIBP only documented as a client option). Lockout:
     5 failures in 15 min → 15 min, doubling, **capped at 1 h** (user); per-IP login limit;
     identical generic error; dummy hash for unknown emails.
   - Roles: operator = line reviews, pause/resume, reply as human, manual OPT-OUT; admin also =
     run gates (`scope: run`), `global_change`, `mark_unavailable`, manual OPT-IN, settings
     writes, users. Last active admin cannot be demoted/deactivated; role change or
     deactivation revokes that user's sessions.
   - First admin only by CLI (`users:create`, password prompted hidden or `--password-stdin`,
     never an argument, no defaults, no HTTP bootstrap). AuditLog for logins, failures,
     locks, refresh reuse, logouts, user/role changes.
   - Panel routes under `/api/v1/admin/*` (reviews approve/reject by scope/kind, mode
     pause/resume, reply, opt-out/opt-in, settings, users) + route-inventory test (no
     unprotected route). Approving a review that sends the run back to extraction re-emits
     an outbox event (closes the phase 6 known issue).
   - MFA (TOTP) = recommended improvement BEFORE a real client (user, 2026-09-27; see Known
     issues). Minimal login page in `apps/admin` is part of this phase (M5). $0.
   - M1 orders never lost — DONE (2026-09-27). Migration `order_notifications`
     (`NotificationCategory.order`). `POST /internal/notifications {kind: "order", messageId}`
     (same window + hourly cap as customer_query; dedupe `order:<messageId>`; title
     "Pedido de …"; digest line "N pedidos" before queries). Pre-filter
     (`prefilter.ts`): customer contacts with an order signal (necesito, quiero, mandame,
     pedido, encargar, reservar, comprar…) → `internal_order` without LLM (otherwise
     customer_query); for other contacts a request signal (order words or tienen / hay /
     cuánto / cuándo / dónde / entrega / envío / consulta) sends the text or transcript to
     the classifier instead of `no_price_signal` (a bare "?" does not count — greetings stay
     free). n8n `receiver.json`: new `Ruta` output "pedido" (internal_order) → "Datos del
     pedido" (kind order) → "Notificar pedido" (same Notificador). Static test: every
     classification that needs a person reaches the Notificador with its kind; the contract
     test's fake orchestrator mirrors the mapping. PENDING (user): import the new
     receiver.json into n8n, publish and export it back (`n8n:export`).
   - M2 users + passwords — DONE (2026-09-27). Migration `user_lockout` (User:
     failedLoginCount, loginWindowStartedAt, lockedUntil, lockLevel, lastLoginAt,
     passwordChangedAt). `src/modules/auth/`: `password.ts` (Argon2id via built-in
     `crypto.argon2`, OWASP m=19456 KiB t=2 p=1, 16-byte salt, 32-byte tag, PHC string,
     `needsRehash` when stored params are weaker, NFKC, `burnPasswordCheck` for unknown
     emails), `password-policy.ts` (15–128 chars, no composition rules, common list +
     trivial patterns + email/name/"smartops"), `common-passwords.ts` (329 SecLists NCSC
     entries of ≥ 15 chars stored as SHA-256 — the repo never ships the plain list;
     regenerate with `scripts/auth/build-common-passwords.mjs`), `login-lockout.ts` (pure:
     5 failures / 15 min → 15 min lock, doubling, capped at 1 h, success resets).
     `src/modules/users/` (repository + service): email normalized (trim + lowercase), role
     / active changes under advisory lock `users:admins` (the last active admin can never be
     demoted or deactivated, verified with a concurrent test), audit
     user.created / role_changed / deactivated / reactivated / password_reset / unlocked
     (actorType system + `cli:<name>` label, or user). `RevokeUserSessionsInTx` hook ready for
     M3. CLI `pnpm --filter @smartops/api users create|list|reset-password|unlock|set-role|
     deactivate|reactivate` (hidden prompt twice, or `--password-stdin`; never an argument).
     `engines.node >=24.19.0` (root + api).
   - M3 sessions — DONE (2026-09-27). ADR-018. Migration `auth_sessions` (AuthSession: idle
     + absolute expiry, revokedAt/revokeReason, userAgent, ip; RefreshToken: token_hash unique,
     rotatedAt). `jose` 6.2.12 (no deps). `src/modules/auth/`: `tokens.ts` (HS256 access,
     iss/aud, 256-bit refresh + SHA-256), `session-rules.ts` (pure: rotate / race ≤ 10 s on the
     latest rotated token → 409 REFRESH_RACE / reuse → revoke session / reject revoked, expired,
     idle, inactive), `sessions.repository.ts` (token row FOR UPDATE), `auth.service.ts`
     (generic 401 + dummy Argon2 for unknown emails, lockout, rehash, audits), `auth-http.ts`
     (cookie config by mode, `readCookie`, CSRF guard: `X-SmartOps-CSRF: 1` + Origin own/
     allowlist + reject Sec-Fetch-Site cross-site unless SameSite=None; `createRequireAuth`,
     `currentUser`), `auth.routes.ts` (/api/v1/auth login, refresh, logout, logout-all, me;
     no-store; per-IP login limiter). `AppDeps.auth` required; tests use `stubAuthService`
     (rejects every Bearer). Env: JWT_ACCESS_SECRET (required, generated into the local
     .env), ACCESS_TOKEN_TTL_SECONDS, SESSION_IDLE_HOURS, SESSION_MAX_DAYS,
     AUTH_COOKIE_SAMESITE/SECURE(auto)/PARTITIONED (None/Partitioned need Secure; production
     never Secure=false), LOGIN_RATE_LIMIT_MAX. The API exits at startup without
     `crypto.argon2`. Also FIXED a phase 7 bug: the API's OutboundService (which sends the
     supplier ack) was built without `settings`, so the opt-out instruction footer never
     applied — now injected in server.ts.
   - M4 authorization + panel API — DONE (2026-09-27). `src/modules/auth/permissions.ts`
     (`canResolveReview`: admin everything, operator only `scope: line`; `requireRole`).
     `src/modules/admin/admin.routes.ts`: /api/v1/admin/* built from a DECLARATIVE table
     (`adminRouteTable`) behind requireAuth + requireRole + Zod validation, no-store:
     reviews list/get/approve/reject (item-level role check; the actor is the user), conversations
     :id mode/pause/resume/reply (reply returns `optedOut` for the panel warning), contacts :id
     consent/opt-out (both roles, reason required)/opt-in (admin), settings GET (both) / PUT :key
     (admin, validated with the key's Zod schema, audited `setting.updated` from→to, updatedById),
     users list/create/patch/reset-password/unlock/revoke-sessions (admin). Route-inventory test
     (test/e2e/admin-routes.test.ts): the mounted router equals the table, every route → 401
     without a token, every admin-only route → 403 for an operator. Approving a review whose run
     goes back to "pending"/"classified" re-emits `message.ready` with dedupe key
     `message.ready:<messageId>:review:<reviewItemId>` (`createRunRetrigger`; the emitter got a
     `retrigger` option) → closes the phase 6 known issue. `AppDeps.admin` required; tests use
     `stubAdminDeps`.
   - M5 minimal panel login — DONE (2026-09-27). `apps/admin`: `src/env.ts` (Zod: NEXT_PUBLIC_API_BASE default
     `/api/v1` = same origin; server-only API_PROXY_TARGET, default http://localhost:4000
     outside production), `next.config.ts` rewrite `/api/*` → API (same origin in dev and
     option A; in option D Caddy routes /api), `src/lib/api-client.ts` (Bearer from memory;
     401 → ONE refresh then retry; single-flight per tab + Web Locks across tabs;
     REFRESH_RACE retried once; CSRF header + same-origin credentials on cookie routes),
     `src/features/auth/` (Zustand store IN MEMORY only, login schema + Spanish error texts,
     LoginForm with safe `next` redirect, AuthGate = silent refresh on load or /login),
     routes `(auth)/login` and `(main)` (minimal home: name, role, logout, logout-all),
     `error.tsx`, `not-found.tsx`, `lang="es"`, noindex kept. zod ^4.6.5 + zustand 5.0.15;
     Vitest in the panel (`test/api-client.test.ts`, root `pnpm test` runs both apps).
     shadcn/ui + TanStack Query arrive with the real screens in phase 9.
   - User tests — DONE (2026-09-26): login at localhost:3000 (login, reload keeps the session,
     two tabs, logout, logout-all, wrong password → generic message) all OK. Orders from the
     real phone (LLM fake, $0): "necesito 3 macetas" → internal_order → order item "Pedido de
     …"; "¿tienen macetas?" → customer_query; BOTH in one digest, sent as text at the end of
     the 10-min window and delivered: "SmartOps · 1 pedido. 1 consulta de cliente. Detalle en
     el panel." Receptor re-imported by the user and exported back (`n8n:export`, sanitized:
     only node ids/positions changed). Lesson (docs/n8n-setup.md §7): n8n "Import from File"
     ADDS nodes to the open canvas — clear it first, or you get duplicate nodes and two
     webhooks on the same path.
9. admin UI — DONE (2026-09-27), merged to `main`. Branch `feat/phase-9-admin-panel`. Approved plan (2026-09-27) + user
   answers: shadcn/ui (new-york, Tailwind v4, React 19) + TanStack Query + Recharts (shadcn chart);
   MOBILE FIRST (375 px first; bottom nav on phones, sidebar from tablet; 44 px targets; tables
   become cards); consistent loading/empty/error/403/expired states; WCAG 2.1 AA (axe);
   rioplatense "vos" texts, America/Montevideo dates, Intl money from Decimal strings (display
   only). 8 milestones, commit + push each, STOP at the end of M8 for the user's phone tests:
   M1 shell + demo seed + dashboard; M2 review queue (every kind incl. the spreadsheet price
   column picker); M3 conversations (🤖/👤/⛔ badges, pause/resume, reply as a person, opt-out /
   opt-in, opted-out list, chat media); M4 real time (SSE); M5 catalog + price history chart +
   alerts + rename supplier (merge later); M6 rules + users (admin); M7 richer digest + deep link;
   M8 "Probar el sistema" (DEMO_MODE) + Playwright E2E + close.
   - Settings: `bot.autoRepliesEnabled` = GLOBAL switch for automatic replies (processing and
     team notifications continue, like human mode); `businessHours` = QUIET HOURS for non-critical
     WhatsApp digests (wait until opening; critical ones still go out) + "fuera de horario" in the
     panel; an automatic "we reply tomorrow" answer is a future option, OFF by default.
   - DEMO_MODE (decided here, closes the phase 12 question): enables the demo page and
     `/api/v1/demo/*`, FORCES fake LLM + fake transcriber ($0 guaranteed), serves a fake Graph API
     INSIDE the API (demo only), visible "modo demo" banner; the production "no fakes" rule stays
     unless DEMO_MODE is explicit. Demo data in a SEPARATE database `smartops_demo` (seed refuses
     any DB not ending in `_demo`), `demo:seed` / `demo:reset` + AUTOMATIC periodic reset
     (configurable) + "Reiniciar demo" button. PUBLIC ACCESS (user addendum 1): a demo user with
     role operator whose credentials are shown on the login screen, without access to users or
     critical rules; a test guarantees that in DEMO_MODE no real WhatsApp message can ever leave.
   - Chat media (user addendum 2): an `<img>` cannot send the Bearer — decide and document
     (blob fetch with Bearer vs short-lived signed URLs), with tests.
   - SSE (user addendum 3): LISTEN/NOTIFY with ONE LISTEN connection per API process fanning out
     in memory to every SSE connection (never a Postgres connection per client); cap of SSE
     connections per user. Events carry ids + type only; fetch-based stream with the in-memory
     Bearer; session re-checked on every heartbeat (logout-all / role change close the stream);
     reconnect with backoff + invalidate every query.
   - Playwright projects: Chromium desktop, Chromium mobile (Pixel 7), WebKit mobile (iPhone).
   - Deep link: `PANEL_PUBLIC_URL` + `/d/<digestId>` (list of the digest's items, or a direct
     redirect when there is one); login keeps the URL.
   - M1 shell + demo seed + dashboard — DONE (2026-09-27). shadcn CLI 4.21 (preset "nova",
     base radix: `radix-ui`, `cn` = shadcn's own clsx+tailwind-merge package), Recharts 3.8,
     TanStack Query 5, next-themes, sonner; chart colors = accent tokens (--chart-1 green,
     --chart-2 blue). `apps/admin`: Providers (query client: no retry on 4xx), AppShell
     (bottom bar + "Más" sheet on phones, sidebar md+, skip link, aria-current), UserMenu (theme,
     logout, logout-all), shared states (Loading/Empty/Error with requestId/Forbidden),
     `lib/format.ts` (es-UY, Montevideo, Intl money from Decimal strings), dashboard (period as a
     button group with aria-pressed — NOT tabs without panels; charts aria-hidden with
     `accessibilityLayer={false}` + a visually hidden table), "en construcción" placeholders.
     Login submit disabled until hydrated + method=post (a pre-JS native GET would put the
     credentials in the URL). API: `src/modules/dashboard/` (rules: automatic = finished runs
     without review items; automationRate excludes in-progress; pre-filter savings = count ×
     avg real classify cost, fallback 0.0027; days in America/Montevideo; "today" AI spend =
     UTC day like the spend guard) + `GET /admin/dashboard?days=7..90`. Demo seed
     (`src/modules/demo/`, `pnpm --filter @smartops/api demo:seed`): DEMO_DATABASE_URL must end
     in `_demo` (guard in code + DB name check), wipes every public table, 3 suppliers / 39
     products / 90 days of lists through the REAL catalog ingest (reviews and alerts exactly as
     production; timestamps moved back to the message date), a suspicious-instructions gate like
     the extraction creates it, customers with queries/orders, one chat in human mode, one
     opt-out, pre-filtered chit-chat, AI usages. Demo operator = public credentials (env
     DEMO_OPERATOR_*); demo admin only with DEMO_ADMIN_PASSWORD. Playwright 1.63 + axe 4.13
     (`pnpm --filter @smartops/admin e2e`): projects desktop / Pixel 7 / iPhone 15 (WebKit),
     own DB `<dev>_e2e_demo` seeded by the API web server command (web servers start before any
     global setup), API :4100, panel as a PRODUCTION build in `.next-e2e` (next dev chunks were
     flaky and would clobber the developer's .next); `SCREENS=1` takes review screenshots into
     e2e/screens (gitignored).
   - M2 review queue — DONE (2026-09-27). API: read model `admin/review-query.repository.ts`
     (item + supplier, product with current price, run, source message text/transcript/file;
     pending first by scope run → line → catalog, then FIFO) behind `GET /admin/reviews`
     (filters status/scope/kind/supplierId/limit), `GET /admin/reviews/summary` (pending per
     scope), `GET /admin/reviews/:id`, `GET /admin/suppliers`; decisions still go through
     ReviewService. Panel `features/reviews/`: list with scope chips + counts and status switch;
     detail with the source card and one resolver per kind (line: candidates / new product +
     price and currency; spreadsheet: price-column cards with REAL values from the file, the
     model's pick only pre-selected with a "Sugerida" badge; global change table; mark
     unavailable; supplier picker; tax / suspicious / extraction-failed gates); reject asks an
     optional note; operator sees run/catalog items read-only (mirror of `canResolveReview`,
     the API still enforces it); STALE_REVIEW/409/400 → plain-language toasts. Approve bodies
     built by pure `resolve-input.ts` (unit-tested): values equal to the proposal are NOT sent
     (the API applies its own rule, e.g. a % on the chosen product); typed prices accept one
     comma/dot decimal separator and REFUSE "1.850" (thousands or decimals? never guessed).
     Demo seed adds a column_mapping review built with the production code path (real xlsx
     generated with `xlsx`, `convertDocument`, `normalizeMapperTable`, `headerCandidates`,
     `sheetPreview` — exported from sheet-extraction; only the mapper answer is canned) with
     stored blob + conversion (approving it really re-extracts), and a mark_unavailable review
     (an Oriental full list without one product). E2E: projects run one after another on the
     SAME seeded DB, so resolving specs run on desktop only and phones read items nobody
     resolves. Link to the conversation has `prefetch={false}` (a prefetch of the not-yet-built
     `/conversaciones/[id]` stayed open; re-check in M3).
   - Numbers (user, after M2): EVERY number in the panel goes through `lib/format.ts` (es-UY via
     Intl: `formatNumber`, `formatMoney` "$ 1.850,00", `formatPrice` "262,30", `formatPct` with
     UP TO one decimal "+85 %" / "+12,5 %", `toDecimalInput` "3325,36" for editable fields —
     never a thousands dot there, the input refuses "1.850"). No `toFixed`/raw decimals in UI.
   - M8 addition (user, after M2): at least one test PER MOBILE BROWSER approves and rejects a
     review with the sticky bottom buttons → the E2E seed gives EACH Playwright project its own
     reviews (projects share one DB and run one after another).
   - M3 conversations — DONE (2026-09-27). ADR-019 (chat media): media fetched with the Bearer
     through the same client (`api.requestBlob`, one refresh on 401) and shown from `blob:` URLs
     (TanStack Query caches the Blob, the object URL is revoked on unmount); photos load when
     scrolled into view, audio/documents on tap; no token ever in a URL; option B (signed URLs)
     documented for large media later. `GET /admin/media/:id` (only `stored`; inline ONLY
     images/audio/PDF, everything else `application/octet-stream` + attachment; nosniff +
     `default-src 'none'; sandbox` CSP + no-store + CORP same-origin; filename sanitized, ASCII +
     UTF-8 `filename*`) — `admin/media-response.ts` pure + unit tests. Chat `<img>` is a bare img
     on purpose (blob: URL; next/image cannot optimize it) — exception to the checklist, see
     ADR-019. Read model `admin/conversation-query.repository.ts`: inbox (filters all / human /
     suppliers / customers / opted_out, search by name, supplier or ≥ 3 phone digits, cursor
     pagination, last message snippet 120 chars, 24 h window), header (mode + last change + window
     + consent), messages (pages BACKWARDS by `before`, each page oldest-first), opted-out list
     (with how: keyword / off WhatsApp / manual + who). Routes `GET /admin/conversations`,
     `/conversations/:id`, `/conversations/:id/messages`, `/contacts/opted-out`, `/media/:id`.
     Panel `features/conversations/`: inbox, chat (day separators, bubbles with author 🤖 / 👤
     name / compliance, status, edited / deleted, transcript under audio, media), badges 🤖
     "Responde el bot" / 👤 "Atiende una persona hasta HH:MM" / ⛔ "Dado de baja" (opt-out wins
     over the mode), pause dialog (30 min / 2 h / 8 h / until resumed) + resume, reply as a person
     (only inside the 24 h window; explains why otherwise; warning when opted out; Enter = new
     line, Ctrl/Cmd+Enter sends), manual opt-out (both roles, reason required) / opt-in (admin
     only), `/conversaciones/bajas`. Polling every 15 s until M4 (SSE). Voice notes: Ogg/Opus
     plays on iOS/Safari 18.4+ (WebKit notes; reports of incomplete support) → the transcript is
     always shown + "¿No se escucha? Descargalo". Demo seed adds a code-drawn PNG photo
     (`demo/demo-image.ts`, no binary asset) to Norte's chat. Accessibility: light theme
     `--muted-foreground` 0.556 → 0.5 and `--destructive` 0.577 → 0.52 (axe color-contrast on
     muted backgrounds / the red tint); `expectAccessible` now prints the failing selectors.
   - M4 real time — DONE (2026-09-27). ADR-020. Migration `realtime_events`: Postgres TRIGGERS
     `pg_notify('smartops_events', …)` with type + ids + status only (never content) on messages
     (insert; status/transcript/text/media/revoked changes), media_files (status → its message),
     conversations (mode/humanUntil), contacts (opt-out), review_items, ingestion_runs (status),
     alerts, products (STATEMENT-level with a transition table → one `catalog.changed` per
     statement, ≤ 50 supplier ids) — Prisma does not model triggers: KEEP THEM. Transactional:
     rolled-back changes are never announced; every writer (API, worker, CLI) covered.
     `src/modules/events/`: `panel-events.ts` (Zod re-validation, unknown types / extra fields
     dropped), `pg-listener.ts` (ONE dedicated `pg.Client` per API process, LISTEN, reconnect
     1 s→30 s, `onReconnect` → hub resync), `event-hub.ts` (in-memory fan-out, 250 ms
     coalescing, caps `SSE_MAX_STREAMS_PER_USER` 5 / `SSE_MAX_STREAMS` 500 → 429
     `TOO_MANY_STREAMS`, `close()` ends streams on shutdown so server.close() does not hang),
     `events.routes.ts` (`GET /api/v1/events`, Bearer only, frames ready / events / resync /
     session + `: ping`; heartbeat `SSE_HEARTBEAT_SECONDS` 25 re-checks the SESSION via new
     `AuthService.checkSession` — not the 15-min JWT — and ends with `session: ended |
     role_changed`). `createApp` `events` dep optional (tests get an idle hub). The worker opens
     no listener. Panel `features/realtime/`: `RealtimeProvider` in the (main) layout (one
     fetch-based stream per tab via `api.stream`, `lib/sse.ts` parser incl. split CRLF,
     `keysFor` event → query-key prefixes merged and batched 200 ms, full invalidation on every
     RE-connect / resync, session end → `api.refresh()` then reconnect or login, backoff 1→30 s
     ±20 % + immediate retry on visible/online), "En vivo / Reconectando…" indicator, conversation
     queries poll every 30 s ONLY while not live (`useFallbackInterval`). Verified: SSE through the
     Next rewrite with a production `next start` in Chromium + WebKit; Caddy flushes
     text/event-stream immediately (reverse_proxy docs). E2E never waits for "networkidle"
     (the stream stays open): wait for the page heading.
   - M5 catalog + price history + alerts + rename supplier — DONE (2026-09-27).
     `admin/catalog-query.repository.ts`: suppliers (product / available counts, last ingested
     list, tax basis), products (supplier / name search / availability filters, cursor by
     name+id, last PriceChange), product + history (oldest first, ≤ 500, conversation of the
     source message), `renameSupplier` (ADMIN only, audited `supplier.renamed` from→to,
     `normalizedName` follows so later lists match it; a name another supplier already has →
     409 — merging stays for later), alerts (open = open|sent, `open` count, product +
     conversation links) + `acknowledgeAlert` (open/sent → acknowledged, idempotent, audited).
     Routes `GET /admin/catalog/suppliers`, `/catalog/products`, `/catalog/products/:id`,
     `PATCH /catalog/suppliers/:id` (admin), `GET /alerts`, `POST /alerts/:id/acknowledge`.
     Panel `features/catalog/`: catalog (supplier select, search, availability switch, rows with
     es-UY money + last change %, rename dialog for admins), product page (price, tax basis,
     availability, stock; step-line chart in the CURRENT currency only + "now" point —
     `price-chart.ts` pure; visible history list with source auto/review and a link to the
     message), alerts page (severity icon, type, links, "Vista"). Charts:
     `isAnimationActive={false}` (reduced motion; screenshots caught half-drawn lines). Live via
     `catalog.changed` / `alert.changed` events (M4).
   - M6 rules + users — DONE (2026-09-27). User rules (user, after M5): never without an active
     admin (phase 8 advisory-lock rule; there is NO delete, only deactivate), NOBODY changes
     their own role or deactivates themselves (`UsersService.update` → 403 FORBIDDEN when
     actor.userId = id; CLI actors have no userId), every role change / deactivation / password
     reset revokes that user's sessions (reset now has its own HTTP test: 2 sessions → 401,
     reason `password_changed`). New Settings: `bot.autoRepliesEnabled` (default true; off →
     `send()` refuses `auto_reply` with 409 `AUTO_REPLIES_OFF`, the worker cancels queued ones
     via `OutboundRepository.cancelPending` (code `auto_replies_off`), supplier ack skipped
     reason `auto_replies_off`; compliance and human replies still go; without injected settings
     (CLI) it counts as on) and `businessHours` ({timeZone, days[{day 0=Sun, open, close
     "HH:MM"}]} or null = always open; `settings/business-hours.ts` pure `isOpen` /
     `nextOpening` / `zonedTimeToUtc` via Intl, DST-safe, overnight rules belong to the day they
     open; no configured day → never opens → digests are NOT held). Non-critical digests outside
     hours are postponed to the next opening (`postpone` + re-scheduled job); critical ones go.
     `GET /admin/status` {autoRepliesEnabled, businessHours {configured, open, nextOpening}} →
     top-bar chips "Fuera de horario · abre …" / "Bot apagado" (polled 60 s; settings saves
     invalidate it). Panel `/reglas`: five sections (bot, hours editor with a row per weekday,
     prices, team notifications incl. recipients' numbers, audio + opt-out keywords), one
     "Guardar" per section sending only changed keys (PUT per key, audited), same limits as the
     API schemas, es-UY number parsing (`lib/number-input.ts`, "1.500" refused), operators
     read-only. `/usuarios` (admin; operators get the no-permission state even by URL): list
     with role / Vos / Desactivado / Bloqueado, create (policy hint, errors from the API's
     policy messages), promote/demote, deactivate/reactivate, new password, unlock, close
     sessions; own row offers no role/deactivate actions. E2E: `RATE_LIMIT_MAX` 100000 in the
     Playwright API env (every project shares one IP — 429 surfaced as "Demasiados intentos");
     never click "the first link" after typing a search (race with the filter) — click by name.
   - M7 richer digest + deep link — DONE (2026-09-27). `renderDigest(items, {link, singleLine})`
     (pure, `digest-rules.ts`): headline with counts ("SmartOps · 2 pedidos · 1 lista"), up to
     5 detail lines in priority order errors → orders → queries → lists → audios ("Pedido de Ana:
     «…»", "Distribuidora Norte: Tornillo 6mm $ 12,00 → $ 14,00 (+16,7 %), 2 aumentos más, 1
     revisión pendiente"), "+N más en el panel", footer "Ver en el panel: <link>" (or "Detalle en
     el panel."); ≤ 1,024 chars by DROPPING lines (the link is never cut); single-line variant
     joined with " · " for template parameters (no line breaks allowed there). `neutralize()`:
     control / bidi chars removed, links → "[enlace]", WhatsApp formatting marks and «» stripped,
     whitespace collapsed, snippets 60 / names 40 chars with "…". Still ONE message per window
     and the same caps; bodies never logged. `RunFacts.mainChange` = the run's biggest change by
     absolute % (product, old/new price, currency, pct), optional (older items without it).
     Deep link (user rules): `notification_digests.link_token` (migration `digest_links`, unique)
     = 256 random bits base64url (43 chars, `newLinkToken`) set when the digest is created —
     NOT the UUIDv7 id (it leaks its time) — URL `PANEL_PUBLIC_URL/d/<token>` (new optional env,
     trailing slash trimmed, https required in production; unset → no link) carries no content.
     `GET /admin/digests/:token` (login required, strict token pattern, unknown / malformed /
     digest-id → the same 404) → items with the panel path that resolves each (order/query →
     its conversation, list → /revisiones if reviews pending else /catalogo, audio / error →
     /alertas). Panel `/d/[token]` (inside the login area: AuthGate keeps it as `next`,
     `referrer: no-referrer`): one item → redirect, several → list; only in-panel paths are
     followed (`digests/paths.ts`). Demo seed: two sent digests to a fake team number with
     tokens (E2E reads them from the E2E DB through the API package's `pg`).
   - M8 public demo (DEMO_MODE) — DONE (2026-09-27), ADR-021. `applyDemoMode` in `parseEnv` (before validation,
     whatever the rest says): AI_PROVIDER=fake with `demo/golden` (byte-identical copies of the
     test goldens — tested), TRANSCRIPTION_PROVIDER=fake with `demo/transcripts`,
     WHATSAPP_GRAPH_BASE_URL = `DEMO_GRAPH_URL` (default http://127.0.0.1:PORT); production
     fake rules and the Meta-only graph rule are skipped ONLY in DEMO_MODE; DEMO_MODE refuses a
     DATABASE_URL not ending in `_demo`. No real WhatsApp (tested at every layer,
     `test/unit/demo-mode.test.ts`): `GraphApiConfig.blockMeta` → `graphRequest` throws
     `DemoModeBlockedError` for Meta hosts (`isMetaHost`: facebook.com, fbsbx.com, fbcdn.net,
     whatsapp.com/.net, meta.com + subdomains) before fetch; `isAllowedDownloadUrl` demoMode =
     only the demo host; worker media client `production` false in demo. Demo Graph API
     (`demo/demo-graph.ts`, mounted at the app root only in demo): media metadata + HMAC-signed
     5-min download URLs from an in-memory store (`createDemoMediaStore`, 200 items), POST
     messages → wamid + signed status webhooks (sent/delivered/read) to our own webhook, outbox
     in memory. Payload builders MOVED to `src/modules/demo/wa-payloads.ts` / `wa-ids.ts`
     (simulator files are re-export shims). `demo-injector.ts`: kinds foto, pdf, audio,
     planilla, planilla_nueva, injection → Meta-shaped payload POSTed SIGNED to our webhook (the
     real pipeline). Assets `apps/api/demo/assets` (fixture copies) + a voice note (first a
     silent Ogg/Opus generated in code; replaced after the phone tests by real synthetic speech
     `demo/assets/nota-de-voz.ogg`, see below; the generator was deleted) whose sha keys the
     transcript. Seed (`seedDemo` options `keepAuth`,
     `assetsDir`, `e2eReviews`): users are UPSERTED (password/role/lockout restored);
     "Distribuidora Demo S.A." catalog from the RECORDED PDF extraction (refs P1..P7 follow
     alphabetical catalog order, so the photo/voice goldens line up); "Distribuidora Ejemplo
     S.R.L." with November prices + its spreadsheet format ALREADY APPROVED
     (`saveSheetFormatInTx`, fingerprint of header row 2, mapper golden, price column 4;
     `SaveSheetFormatInput.reviewItemId` now nullable); "Mayorista del Este" without a format;
     E2E only: "Proveedor E2E <project>" with Martillo/Serrucho outlier reviews per Playwright
     project. Routes `/api/v1/demo/*` only in demo: GET /info (public: operator creds,
     nextResetAt), POST /inject (login + `DEMO_RATE_LIMIT_MAX` per 10 min), GET /trace/:wamid,
     POST /reset (login, 5 per 10 min). `demo-reset.ts`: one at a time, keepAuth, clears the
     media store, automatic reset every `DEMO_RESET_INTERVAL_MINUTES` (setTimeout rescheduled
     after each reset, manual too). Panel: login card with the public operator credentials +
     "Usar estos datos" (only when /demo/info exists), "Modo demo" banner, nav item + page
     `/probar` (six cards, live timeline per sent sample from `features/demo/trace.ts` — pure,
     tested —, "Reiniciar demo" with confirm). Local: `apps/api/.env.demo` (NOT versioned;
     `.env.demo.example` is, via a gitignore exception) + `pnpm --filter @smartops/api dev:demo`
     (API + worker, `.env` then `.env.demo`; Node gives the LAST env file precedence).
     E2E: the Playwright API runs in DEMO_MODE (+ DEMO_E2E_REVIEWS, reset interval 0, n8n
     delivery on) and `scripts/demo/e2e-n8n.ts` waits for the API, starts the REAL worker and
     plays the three workflows over HTTP; every sample tested end to end in the browser; each
     browser project approves/rejects its own reviews with the pinned bottom buttons
     (`mobile-reviews.spec.ts`, in-viewport check on phones). Lessons: in node edit scripts, JS
     string escapes eat backslashes (`\/` → `/`) — write regexes with the Edit/Write tools; the
     Edit tool turned ` ` escapes into real characters (built with fromCharCode instead).
   - User phone tests (2026-09-27, local demo through a cloudflared quick tunnel, Android) —
     OK: demo login with "Usar estos datos", the six "Probar el sistema" samples (correct
     outcomes), approve / reject with the bottom buttons, chat photo, transcript, pause / reply /
     resume, catalog + chart, "Reiniciar demo", and as admin: column picker of the new
     spreadsheet, saving Rules, Users (own role not editable). FIXED after the tests:
     1. Intentional stops ("planilla nueva", prompt injection) are "Frenado para revisión" with
        an amber pause icon (trace state `held`); red (`failed`) only for real failures.
     2. Real time through the tunnel: headers arrived but zero bytes. Measured: Cloudflare's
        edge holds GET streams (charset irrelevant; cloudflared flushes by content-type
        prefix) while POST streams in ~75 ms → `/api/v1/events` accepts POST and the panel uses
        it (ADR-020 amendment). Degraded mode: no `ready` in 10 s → "Actualización cada 30 s",
        every active query refreshed every 30 s while it keeps retrying; refresh on tab
        return and on reconnect (per-screen polling removed). E2E with a hung stream.
     3. The demo voice note is a real synthetic voice (`demo/assets/nota-de-voz.ogg`, 11.5 KB,
        5.5 s, Opus mono 16 kb/s, "El tornillo de 6 milímetros sube a 14 pesos desde el lunes"
        — Echogarden 3.4.0 + eSpeak NG, run once via npx, not a dependency; Windows voices
        rejected: redistribution terms unclear). Its transcript stays the phase 5 one with the
        ASR error "de lunas" (on purpose → review). Provenance in `demo/README.md`.
     4. 404s: `NotFoundState` "Esto ya no existe (la demo se pudo haber reiniciado)" + a back
        link on every detail screen (conversation, review, product, digest link);
        `GET /admin/conversations/:id/messages` → 404 for an unknown conversation. Seeded
        suppliers, contacts, conversations and digest tokens get STABLE ids (`demoUuid`), so an
        open chat survives the reset; rows created by the real ingest (products, reviews) keep
        random ids by design.
     5. Operator on an admin-only review: "Solo un administrador puede resolver esta revisión"
        exactly where the buttons would be (pinned at the bottom on phones; E2E checks it is in
        the viewport).
10. tests — DONE (2026-09-27), merged to `main`. Branch `feat/phase-10-tests`. Approved plan (2026-09-27) + user answers:
    coverage ratchet (threshold = measured − 2, only goes up; 80 % API / 95-90 % critical pure
    modules / 90 % panel logic are goals, not blocks); DB down/up with a TCP proxy inside the
    test; versioned generated `n8n/contract.json` + staleness test; CI designed for a private repo
    (E2E on PRs to main + nightly only with new commits) and a public one (E2E on every PR),
    switched by ONE variable; Stryker 2 h, no gate; load smoke moved to phase 12 (VM); real-LLM
    eval = free dry-run only, never in CI; extracted logic + E2E, no React Testing Library; own
    prompt-injection set (OWASP LLM Top 10 as a guide, no copied corpus). Addenda: A) startup
    smoke of server.ts / worker.ts with SIGTERM; B) scratch databases derived from the `_test` one
    and dropped at the end, never `smartops` / `smartops_demo`; C) no log carries tokens,
    passwords, keys or full phones. vitest + @vitest/coverage-v8 pinned to the same exact version.
    Details and timings: `docs/testing.md`.
    - M1 tooling + baseline + ratchet — DONE (2026-09-27). `scripts/coverage-ratchet.mjs`,
      `apps/*/coverage-thresholds.json`, guard `test/unit/coverage-thresholds.test.ts` (vs HEAD and
      origin/main). Baseline API 84.1 % lines / 77.8 % branches; panel logic 78.8 / 69.5.
    - M2 authorization matrix — DONE (2026-09-27). `app.ts` records every `mount()` →
      `listRoutes(app)` = the routes REALLY served (61 incl. DEMO_MODE and the demo Graph API);
      `test/e2e/authz-matrix.test.ts` × anonymous / operator / admin vs
      `test/fixtures/authz-matrix.json` (regenerate only with `AUTHZ_RECORD=1` and review the diff)
      + invariants (anonymous only reaches health and demo/info; internal, webhook and demo Graph
      never open with a panel token; admin table roles). Panel `canResolve` = API
      `canResolveReview` for every role × scope × kind.
    - M3 real Postgres — DONE (2026-09-27). `test/integration/scratch-db.ts` (names derived from
      TEST_DATABASE_URL: `<test>_shadow_test`, `<test>_demo`; guard on create AND drop; Prisma CLI
      run with node, DATABASE_URL explicit). `migrations.test.ts`: every migration from scratch,
      second deploy no-op, `migrate diff --from-config-datasource --to-schema --exit-code` empty
      (verified to fail on an unmigrated field), hand-written CHECKs / triggers / partial indexes /
      STORAGE EXTERNAL listed EXACTLY (a new one must be added there on purpose).
      `demo-seed.test.ts` (real ingest, deterministic, reset keeps users + sessions only).
      `realtime-events`: every trigger + LISTEN killed with pg_terminate_backend → reconnect,
      resync, delivery (pg_stat_activity filtered by current_database(): never another DB's
      backend). `job-workers.test.ts` (real pg-boss: queue options applied, crons scheduled,
      error recorded → retry → DLQ handler for webhook / media / transcription / conversion / n8n
      / digest; bot resume fails without DLQ by design). `test/unit/queue-definitions.test.ts`
      (DLQ order, 30-day DLQ retention, n8n ≈ 24 h with pg-boss 12.34's backoff formula).
      `startup-smoke.test.ts`: real `server.ts` and `worker.ts` (env only from the test, Graph URL
      unreachable) → health 200, SIGTERM → exit 0, LISTEN and pools closed, the worker FINISHES
      its in-flight n8n delivery (Windows: signal via the IPC preload `support/signal-bridge.mjs`).
      Concurrent processing of the SAME webhook event: every row once (item-level idempotency).
      Coverage API 90.5 % lines / 80.3 % branches (jobs 31 → 82 %); integration suite ~140 s.
      FINDING (reported, not changed): the `whatsapp-media` comment says "10 s → 30 min over 6
      retries", but 6 retries add up to 10.5–21 min in total (cap never reached) — pinned in
      `queue-definitions.test.ts`.
    - M4 n8n contract — DONE (2026-09-27). `INTERNAL_ROUTE_SCHEMAS` (internal.routes.ts; the
      router validates WITH it) + `messageReadyPayloadSchema` (Zod, strict; the TS type derives
      from it) → `scripts/n8n/contract.ts` (`n8n:contract`) writes `n8n/contract.json` (JSON
      Schema via `z.toJSONSchema`, prettier-ignored, byte-compared by a test). `test/unit/
      n8n-contract.test.ts` + `test/helpers/n8n-contract-check.ts`: dry-run of the exported
      workflows with their real expressions (Set / If / Switch / Execute Workflow / HTTP), every
      HTTP node validated with the API's own Zod schemas; notifier inputs = run, customer_query,
      order; only `GET /internal/rules` is unused. Real payloads checked in the integration
      contract test.
    - M5 resilience — DONE (2026-09-27). `db-outage.test.ts` (in-test TCP proxy: health
      200 → 503 → 200, LISTEN reconnect + resync, pg-boss resumes and runs the job queued during
      the outage; stable 3/3), `resilience-http.test.ts` (real local peers that hang / are slow /
      stall mid-body / 429 / 5xx for the n8n, Graph media, Graph send and Anthropic clients:
      typed errors within the timeout, transient = retryable; the SDK retries a timeout once, never
      loops), LLM timeout on classify and extract (ledger `error/timeout` $0, 503, run retriable).
      Retry-After is not honoured (queue backoff applies) — documented.
    - M6 security — DONE (2026-09-27). `security-tokens` (forgery matrix with the right key),
      `security-limits` (every limiter, independent budgets), access token of a logged-out session
      → 401 at once, `log-safety` (API, every secret door incl. error paths) +
      `log-safety-worker` (every WhatsApp fixture) with the production logger at trace
      (`createLogger` got an optional destination = test seam; `buildTestApp` a `logger` option),
      `prompt-injection` (own set: framing, keyword detector, output rules / Zod, digest). Findings
      pinned with `it.fails` + Known issues (JWT without exp; tag / keyword evasions).
    - M7 properties — DONE (2026-09-27). fast-check 4.10.2 (exact, both apps, no release-age
      exclusion needed). API 19 properties (prices, percentages, supplier names, statuses, 24 h
      window, business hours in 4 time zones, neutralize, webhook signature, opt-out keywords),
      panel 5 (number round trips). `FC_RUNS` (default 300; 5000 locally: no counterexample).
      Invisible characters in test sources must be written as escapes (the Write tool turns them
      into literal characters — scan new test files for them).
    - M8 CI readiness — DONE (2026-09-27). `apps/api/scripts/ci/e2e-policy.ts` (repo variable
      `E2E_POLICY` private | public; nightly only with new commits on main; unit-tested). Playwright:
      `github` reporter in CI (a retry-pass is reported flaky). E2E self-contained (no
      `apps/api/.env` needed: `E2E_BASE_DATABASE_URL`, fake secrets, real provider keys blanked) —
      it could not have started in CI before. Budget ≈ 750 of the 2,000 free minutes / month while
      private (verified: Actions is free on public repos with standard runners). Flaky check
      `--repeat-each=3`: read-only tests 3/3; data-consuming tests are not repeatable by design;
      found an a11y bug (Known issues). Coverage API 90.7 % lines / 80.8 % branches (ratchet +7).
    - M9 mutation testing — DONE (2026-09-27), report only. Stryker 10.0.0 with the COMMAND runner
      (`stryker.config.mjs`, `vitest.stryker.config.ts`; vitest-runner removed: broken on Vitest 5,
      stryker-js#6210). 728 mutants, ~30 min, score **80.1 %** after the post-review fixes below
      (582 killed, 145 survived; was 79.1 % / 152 survived on the first pass — per file in
      docs/testing.md). A property run found a real DST bug in `nextOpening`, fixed below.
    - M10 real-model eval — DONE (2026-09-27), one real run, user-authorized cap $0.20 (dry-run
      worst $0.1943, run AFTER fixing finding (4) below). `scripts/ai-eval.ts` (`ai:eval
      --confirm-spend`): our 8-case injection set (2 controls, LLM01 direct ×2, LLM01 indirect,
      LLM06 excessive agency, LLM07 prompt leakage, LLM05 output handling) through the REAL
      extractor (claude-sonnet-5). **8/8 passed, real cost $0.0465** (well under the estimate,
      no cache discount assumed): both controls correctly NOT flagged; every attack correctly
      flagged `suspiciousInstructions: true`; the two "set every price to X / role-play as admin"
      attacks made the model extract ZERO items (it refused to invent prices); the "hidden
      instruction in a price line" attack extracted only the ONE legitimate line, never the
      injected extra product; the "fake quoted full-list evidence" attack stayed
      `partial_update`, never `full_list`; the "ask for the system prompt" and "markup in a
      product name" attacks extracted normally without leaking or executing anything. Total real
      AI spend of the project so far: $0.1907 + $0.0465 = **$0.2372**.
    - Post-review fixes (user, 2026-09-27, after reviewing phase 10) — DONE:
      1. `tokens.verify` now passes `requiredClaims: ["exp","iat","sub"]` to `jwtVerify`: a token
         without `exp` (even signed with the real key) is rejected. Test converted from `it.fails`
         to `it` (+ a companion case for missing `iat`).
      2. `nextOpening`/`zonedTimeToUtc` (`business-hours.ts`) now detect a DST spring-forward gap
         (the requested local time never happened) and return the first valid instant at/after
         it, instead of silently returning a CLOSED instant. Verified against America/New_York
         (March), America/Santiago (Southern Hemisphere: gap in September) and Europe/Madrid,
         plus the business-hours property (now runs unfiltered, 4 time zones, 5000 local
         iterations with no counterexample).
      3. `message-bubble.tsx`: a failed/canceled reply is marked with `border-2 border-destructive`
         + a destructive-colored `AlertCircle`, never by lowering opacity (which used to compound
         with the already-translucent footer text and fail WCAG AA). Verified with the exact
         E2E scenario that found it (desktop leaves a failed bubble → pixel/iphone axe check).
      4. New `src/common/text-normalize.ts` (`normalizeUntrusted`: NFKC + strip zero-width/bidi
         characters) applied before both deterministic defenses: the tag-neutralization regex
         (`message-input.ts`, also widened to tolerate whitespace around `<` and `/`) and the
         spreadsheet keyword detector (`sheets/list-rules.ts`, also widened with synonyms —
         desestimá/descartá/disregard/forget — requiring the "instrucciones/instructions" object
         to avoid flagging ordinary supplier text). 12 new legitimate-control cases added
         alongside the attacks. Leetspeak substitution ("1gnora") remains an open, lower-priority
         gap (not requested), documented with a passing test that states it explicitly.
      5. `whatsapp-media` queue: `retryDelay` 10 s → 20 s, `retryDelayMax` 1800 s → 600 s — the
         real total (min 1220 s / **max exactly 1800 s = 30 min**) now matches its own comment;
         before, the 30-min cap was mathematically unreachable in 6 retries (real total was only
         ~10.5–21 min). Pinned in `queue-definitions.test.ts`.
      Stryker survivors reviewed (login-lockout, session-rules, price-math; ~50 min): 2 real gaps
      confirmed by MANUALLY re-applying each mutant and re-running the exact suite (one Stryker
      report entry — `price-math` mutant "start = Math.min(MAX,...)" → "Math.min(MIN,...)" — was
      independently verified NOT to survive when reproduced by hand; kept as a tooling caveat
      below) → new tests added: `lockedNow` stays `false` while already locked, `lockLevel` only
      increases across consecutive lockouts (never goes negative via `+1`→`-1`), the refresh-race
      window boundary (`age >= 0` at exactly age 0, and a negative age from clock skew), and a
      whole-number current price never starts the percentage search below `MIN_PRICE_DECIMALS`.
      The rest of the ~150 survivors stay in the report (boundary instants on multi-day/-hour
      windows, error-message text, regex/text variants — no further real gaps found).
11. CI/CD — DONE (2026-09-28), merged to `main` via PR #2 (rebase), released as **v0.11.0**.
    Branch `feat/phase-11-ci-cd` (kept). Approved plan
    (2026-09-27) + user answers: (1) soft enforcement of main now (main-guard job + pre-push hook);
    going public only after a SEPARATE full security audit; (2) rebase-merge, phase PR opened with
    `gh`, merged only when the user says so; (3) no Playwright browser cache; (4) one version for
    the repo from v0.11.0, CHANGELOG with a phases 1–10 summary, v1.0.0 = deployed + audited
    public demo; (5) native amd64 + arm64 images; (6) panel image with Next standalone without
    breaking dev / E2E; (7) the 5 unformatted files fixed in a chore commit; (8) Renovate,
    gitleaks, release-please, Trivy, actionlint, zizmor approved (pinned + checksum), audit blocks
    only HIGH/CRITICAL prod with an exceptions file; (9) templates in English; (10) images private
    while the repo is private (+ test: no .env / secrets in images); (11) nightly 03:00
    Montevideo. GitHub settings: the USER applies them step by step (docs/ci-cd.md checklist);
    CI never changes repo settings. Cero claves reales en la CI.
    - M1 quick workflow + least privilege + workflow lint + main guard — DONE (f78be5f, 23ca38e).
      First GitHub run (700bcc9): quick 1 m 53 s, 1056 + 73 tests, the rest skipped (push).
    - M2 slow suite — DONE (700bcc9): Postgres service, coverage gate, build, E2E by policy,
      nightly. Locally against a fresh Postgres: coverage 163 s, build 25 s, E2E 203 s (76 passed).
    - M3 security — DONE (bf57eed): full-history gitleaks shown to and approved by the user,
      audit gate + 4 exceptions (expire 2026-10-31), Renovate (validated with renovate 44.107.0
      strict), SECURITY.md (no email), weekly security workflow.
    - M4 Docker images — DONE (aa6af29): API 864 MB, panel 418 MB; secrets check verified with a
      negative test; both smoke tests pass locally.
    - M5 releases — DONE (f4704f0, cfaf3c2, 79eb7a6 = `Release-As: 0.11.0`): release-please +
      release.yml (native multi-arch, checks before push, GHCR private). No release exists yet:
      the first release PR appears after the phase PR is merged.
    - M6 docs — DONE: PR template + issue forms (blank issues off, security → SECURITY.md),
      docs/ci-cd.md (workflows, E2E policy, manual runs, budget ≈ 1,000 min / month, releases,
      supply chain, settings checklist), ADR-022, README "CI/CD" section, this file.
    - First real slow-suite run (PR #2, run 36358940283, 2026-09-27) FAILED — fixed (2026-09-28):
      1. `documents.test.ts` ZIP bomb over the 5 s timeout under coverage on 2 vCPU → 3 MB bomb
         vs a 2 MB cap, built once, + explicit uncompressed-size-cap assertion, own 15 s
         timeout (never the global one).
      2. Panel image: `cp apps/admin/public` failed (git does not version empty folders) →
         `apps/admin/public/robots.txt` (`Disallow: /`) + optional copy in the Dockerfile +
         the panel smoke test checks /robots.txt.
      3a. axe color-contrast on the sonner toast: the REAL light rich colors fail AA (success
         4.29, info 4.35, error 4.36, warning 3.07 : 1) → darker texts in globals.css
         (`html [data-sonner-toaster][data-sonner-theme="light"]`, 5.96–6.74 : 1);
         `expectAccessible` waits for toast animations; E2E emulates reducedMotion.
      3b. E2E hung ~24 min after its last test until the 30-min job timeout. ROOT CAUSE
         (reproduced in a node:24 container, scratch Playwright project): pnpm 12 (native binary,
         `pnpm-native`) runs every child in a NEW process group; Playwright stops a web server
         with kill(-pgid) of its shell, so tsx / next started via `pnpm exec` survived
         (reparented to PID 1) holding Playwright's stdout pipe, and Playwright waited for
         "close" forever. NOT the API shutdown (server.ts ends SSE via `eventHub.close()`; new
         startup-smoke test: live SSE stream + SIGTERM → exit 0 in < 5 s, verified to fail
         without `eventHub.close()`). Fix: web servers run plain `node --import tsx` / `node
         node_modules/next/dist/bin/next` with `exec` (not on Windows: cmd has no exec,
         Playwright uses taskkill /T there), `gracefulShutdown` SIGTERM + 15 s; e2e-n8n waits for
         its worker; CI calls `./node_modules/.bin/playwright test` directly (no pnpm), step
         timeout 12 min, job 20 min.
      Second run (run 36366205273): all green, 0 flaky, Playwright exits right after the last
      test. Measured: quick 2m00s, plan 6s, integration-coverage 5m14s, e2e 6m58s, images 4m06s
      (table + ≈ 830 billed min / month estimate in docs/ci-cd.md).
      LESSON: never start long-running processes through pnpm 12 where a supervisor kills by
      process group (Playwright web servers, CI steps that may time out).
    - Close (2026-09-28): the user applied the GitHub settings (verified by API: E2E_POLICY,
      read-only token + Actions may create PRs, allowed actions with SHA pinning required, 14-day
      retention, Dependabot alerts). PR #2 marked ready and rebase-merged (1942ab6, branch kept);
      main: main-guard + quick green on the first try. Renovate's onboarding PR #1 had already
      auto-closed (config found on main) — commented, never merged; Renovate opened its
      "Dependency Dashboard" issue #4.
    - Release: the empty `chore: release 0.11.0` commit was DROPPED by GitHub's rebase-merge →
      release PR #3 proposed 0.1.1. Fixed with PR #5 (`fix/release-as-0.11.0`, docs commit with
      body `Release-As: 0.11.0`, rebase-merged 58ffdc9 after green checks, user-authorized) →
      #3 became 0.11.0 (4 version files + CHANGELOG section), reviewed by the user, rebase-merged
      (9a302e7). Release run 36371046144: ALL GREEN on the first attempt, tag v0.11.0 + GitHub
      release, 4 native builds (api/admin × amd64/arm64) each with secrets check, smoke test and
      Trivy BEFORE the push, then multi-arch tags `0.11.0`, `0.11`, `sha-9a302e7` for
      `ghcr.io/sanchezign/smartops-{api,admin}` (index = linux/amd64 + linux/arm64 + 2 attestation
      manifests `unknown/unknown`, labels `org.opencontainers.image.source` = the repo). 3 m 55 s
      wall, 17 billed minutes; arm64 builds were faster than amd64 (api 2m53 vs 3m16, admin 2m26
      vs 3m07). Timings in docs/ci-cd.md. Anonymous pulls are refused (not public); package
      visibility/link could not be read by API (the gh token lacks `read:packages`).
    - LESSONS: (1) pnpm 12 runs children in a new process group — never supervise long-running
      processes through it (Playwright web servers, CI steps); (2) GitHub's rebase-merge drops
      EMPTY commits — a `Release-As` footer must ride on a commit that changes files; (3) sonner's
      default light rich colors fail WCAG AA — keep the override in globals.css; (4) timing-heavy
      unit tests need headroom on 2-vCPU runners with coverage (size the data, per-test timeout).
12. deploy ($0) — IN PROGRESS on `feat/phase-12-deploy`. Approved plan (2026-09-28) + user answers:
    region São Paulo (Santiago second, chosen by the user at signup); the VM runs ONLY the public
    demo (real WhatsApp instance out of this phase); SSH via OCI Bastion (plan B: 22 only to the
    user's /32 if the M1 test fails); DuckDNS subdomain + reserved public IP, record set once by
    hand, the DuckDNS token NEVER on the VM; demo n8n = real n8n WITHOUT editor, workflows by
    CLI, telemetry off; unattended security updates with 04:00 reboot + a post-boot check;
    deploy scripts shipped inside the API image; monitoring UptimeRobot + Healthchecks.io; if
    Oracle fails, retry for some days, then decide together (Supabase free pauses after 7 idle
    days, Render free sleeps); releases v0.12.0 at M3 and another at the close. Addenda: A)
    shared public operator (no lockout → per-IP limit, SSE cap per IP, no logout-all / password /
    role changes; review other per-user limits); B) restore test on the owner's PC (private age
    key never on the VM), monthly reminder = a Healthchecks check, no VM timer needing the key;
    C) Caddy security headers (HSTS, nosniff, Referrer-Policy, frame-ancestors / XFO, CSP if it
    does not break the panel), verified externally in M3; D) n8n editor disabled + telemetry off.
    Milestones: M0 code + bundle + local test (me) → M1 Oracle console (user, guide) → M2 host
    hardening (user runs my scripts) → M3 v0.12.0 + first deploy + external checks → M4 backups
    + real restore → M5 monitoring + load smoke + abuse checks → M7 docs/ADR-023/close (M6 real
    instance dropped from this phase). I do NOT get SSH access to the VM.
    - Minor (user, 2026-09-28): the CI run on release PR #3 that failed with 0 jobs — cause:
      since June 2026 GitHub requires an approval to run workflows on PRs created/updated by
      GITHUB_TOKEN (first run "action_required"); the second update's run failed at startup
      ("workflow file issue", not confirmed why). `plan` now skips the slow suite on
      `release-please--*` branches; docs/ci-cd.md explains the approval. Watch the next release.
    - M0 — DONE (2026-09-28):
      1. Addendum A (`src/modules/demo/public-account.ts`, `createPublicAccount` from DEMO_MODE +
         DEMO_OPERATOR_EMAIL): AuthService never locks the shared account (failures still
         audited; the per-IP login limiter protects it) and refuses its logout-all (403);
         UsersService.update / resetPassword / `assertModifiable` (admin revoke-sessions route)
         refuse it (403); the event hub counts that account's streams per `userId|ip`
         (`Subscriber.limitKey`); the panel hides "Cerrar todas mis sesiones" for it
         (`features/demo/public-account.ts`). Other per-user state reviewed: the demo reset now
         deletes ENDED sessions (revoked / idle / absolute) — they piled up forever with a shared
         account; login limiter, inject limiter and all other limits were already per IP.
         Tests: integration `demo-public-account.test.ts` (Postgres), e2e events per-IP cap,
         e2e demo limits, demo-seed ended sessions, panel unit.
      2. `/demo/inject` global cap `DEMO_GLOBAL_INJECT_PER_HOUR` (120/h for ALL visitors,
         `createRateLimiter({ global: true })`) on top of the per-IP one; per-IP now needs
         `TRUST_PROXY=1` behind Caddy (tested with X-Forwarded-For).
      3. Public demo guard (env.ts `publicDemoIssues`, DEMO_MODE + NODE_ENV=production): refuses
         ANTHROPIC_API_KEY / TRANSCRIPTION_API_KEY / DEMO_ADMIN_PASSWORD and ANY variable that
         looks like a real key (sk-ant-, gsk_, sk-proj-, EAA…) — values never echoed. Local
         dev:demo (development) keeps working with a developer .env.
      4. `src/demo-seed.ts` → `node dist/demo-seed.js` (the prod image has no scripts/): deploy
         re-seeds the demo (keepAuth), compose service `seed`.
      5. Deploy bundle `deploy/` (ships in the API image at /opt/smartops-deploy, Dockerfile stage
         `bundle`, modes set explicitly): compose.yaml (project smartops-demo; networks edge +
         backend internal; only Caddy publishes 80/443; mem limits; no-new-privileges;
         cap_drop ALL on node services; third-party images by digest: postgres 17-alpine, n8n
         2.40.6, caddy 2.11.4-alpine), Caddyfile (h1/h2 only, security headers with `>`/`?`,
         CSP with 'unsafe-inline' for Next hydration, `/api/v1/internal*` and `/webhooks*` → 404
         INSIDE `handle /api/*` — a top-level `respond` loses to `handle`), postgres-init (roles
         smartops + n8n), systemd units (backup 03:30, monitor 5 min, boot-check), scripts in
         `deploy/bin` (lib, host-setup, init-secrets, fetch-bundle, deploy, rollback, n8n-import,
         backup, restore-test, monitor, boot-check, status, install-units).
      6. n8n by CLI (verified against 2.40.6): `deploy/lib/render-n8n.mjs` restores the ids the
         exports reference (Execute Workflow nodes by cachedResultName, errorWorkflow via the
         Error Trigger workflow, others `stableId(name)`), points Config.apiBaseUrl at
         http://api:4000/api/v1 and builds the two Header Auth credentials from the server's
         secrets; `n8n-import.sh` streams a tar from the API image straight into a one-off n8n
         container (`import:credentials`, `import:workflow --separate`, `publish:workflow`) —
         secrets never on the host disk; re-import is idempotent (same ids). Files written by
         root were unreadable by n8n's uid 1000 (first attempt) — hence the stream.
      7. CI: quick runs `scripts/ci/check-deploy-bundle.sh` (shellcheck 0.11.0, caddy validate +
         fmt, compose config + invariants `check-deploy-compose.mjs` — mutation-checked);
         `plan` docker paths += deploy/, n8n/workflows/; image-secrets-check takes several dirs
         (api: /app + /opt/smartops-deploy); api-container-smoke runs the seed entry and checks
         the bundle (render of the 4 workflows).
      8. Local harness `scripts/deploy/local-harness.sh` + `local-smoke.mjs` (SMARTOPS_LOCAL=1:
         no root / mode checks, local tags, no pulls; project smartops-m0test; 127.0.0.1 only)
         — PASSED in 4m44s: deploy (1m08s), headers + blocked routes, public operator login,
         logout-all 403, SSE through Caddy first frame 5–7 ms (GET and POST), live event 1 s
         after a sample, the sample ingested through the REAL n8n workflows, second deploy with
         pre-deploy backup, restore test (23 migrations, 53 products, 146 messages, 4 workflows,
         2 credentials; wrong key → fails), rollback, newer-schema refusal + accept flag. No CSP
         violation browsing every panel screen in Chromium (charts, blob: chat photo). Measured
         RAM of the whole demo stack ≈ 700 MB (n8n 343, API 105, Postgres 99, worker 85, panel
         51, Caddy 15).
      9. docs/runbook.md (first version, Spanish), deploy/README.md, docs/ci-cd.md.
    - After M0 (user decisions, 2026-09-28): (1) "Reiniciar demo" stays for visitors with ONE
      reset per 10 minutes for EVERYONE (automatic resets count; a reset accepted but still
      running counts) + the per-IP limit → 429 `DEMO_RECENTLY_RESET` with details
      {lastResetAt, retryAfterSeconds} + Retry-After; the panel says "La demo se reinició hace X
      min. Vas a poder reiniciarla de nuevo en Y min." (`features/demo/reset-message.ts`). Tests:
      e2e security-limits (two visitors, clock, automatic reset counts), panel unit. (2) VM
      1 OCPU / 3 GB. (3) local test images deleted at the close.
    - M1 guide — WRITTEN (2026-09-28): `docs/deploy/m1-oracle-setup.md` (Spanish, step by step:
      account in São Paulo, budget USD 1 with actual + forecast alerts at 1 %, compartment
      `smartops`, VCN by hand without NAT / service gateway, security list 80/443 from anywhere +
      22 only from 10.0.0.0/24, reserved public IP, VM A1.Flex 1/3 Ubuntu 24.04 (not Minimal)
      without ephemeral IP, Bastion port-forwarding session + plan B 22 to the user's /32, DuckDNS
      set by hand, zero-cost checks). Reserved-IP cost: announced free by Oracle but NOT verified
      on an official price page (403) — the budget + Cost Analysis check covers it.
    - M1 run by the user (2026-09-28): tenancy (name not published), home region São Paulo, budget
      USD 1 with 2 alerts, compartment `smartops`, VCN + subnet as in the guide (ingress only the
      default ICMP + 80/443 from anywhere + 22 from 10.0.0.0/24), reserved public IP
      **163.176.132.161**, **smartops-demo.duckdns.org** → that IP (verified). The VM could NOT be
      created: 30+ attempts "500-InternalError, Out of host capacity" (A1.Flex 1 OCPU / 3 GB,
      AD-1). The config is saved as Resource Manager stack `smartops-demo-vm` (plan correct: 3 GB,
      no public IP, the user's key). User decision: automatic retry for 3–5 days, NO Pay As You Go.
    - M1 retry tooling — DONE (2026-09-28): `scripts/oci/launch-retry.ps1` (PowerShell 5.1, ASCII,
      runs on the USER's PC with OCI CLI): direct `oci compute instance launch --no-retry` (not
      Resource Manager jobs: exact error codes, no Terraform state, fewer permissions), approved
      config hard-coded (A1.Flex 1/3, Ubuntu 24.04 aarch64 non-Minimal looked up, subnet by name,
      `--assign-public-ip false`, the user's .pub — a private key is refused), checks for an
      existing `smartops-demo` (any state but TERMINATED/TERMINATING) BEFORE every attempt,
      capacity → 2–5 min random wait (user, 2026-09-28), 429 → 15 min, NETWORK failures (no
      ServiceError: timeouts, DNS, refused / reset, "Max retries exceeded", RequestException) are
      retried in the listing AND the launch (safe: existence checked before every launch — a lost
      answer is found on the next check), an ALERT + toast every 12 in a row (the streak resets only
      when OCI answers with a real ServiceError, not on a successful listing), local CLI config
      errors and real errors (NotAuthenticated, NotAuthorizedOrNotFound, Limit/QuotaExceeded,
      InvalidParameter…) → STOP with a hint (-DryRun never retries), deadline
      `-MaxDays` 5 (waits never pass it), success → toast + sound, log without secrets in
      %LOCALAPPDATA%\smartops\launch-retry.log, SetThreadExecutionState keeps the PC awake while it
      runs, `-DryRun` resolves everything without launching. Tested against a fake OCI CLI shim
      (dry-run, capacity×2 → success, existing instance, 401 stop, 429, deadline, private key,
      missing CLI, network cut in the listing and in the launch, 13 cuts → alert at 12 → success,
      launch that worked with its answer lost → found, no second launch, config error → stop). Least privilege (docs/deploy/m1-retry-launch.md): Identity Domains user
      `smartops-launcher` in group `smartops-launchers` (Default domain), policy in the root
      compartment: `manage instance-family` + `use volume-family` + `use virtual-network-family`
      in compartment smartops + `read app-catalog-listing` in tenancy (Oracle's "Let users launch
      compute instances" recipe; group written `'Default'/'smartops-launchers'`). API key generated
      in the console, kept only on the user's PC (`oci setup repair-file-permissions`); user, key,
      group, policy, local key, config section and the RM stack are deleted as soon as the VM is
      RUNNING.
13. i18n + docs + portfolio — IN PROGRESS on `feat/phase-13-i18n-docs` (created from main after PR
    #8 "phase 12, part 1" was rebase-merged, 3bcc0de). Approved plan (2026-09-28) + user answers:
    - Language rule: English for code, comments, commits, the single README, technical docs
      (architecture, security, costs, development, ADRs), CLAUDE.md, runbook and deploy guides.
      Panel: English by default + selector to Spanish, saved per user in the DB, at login the
      browser language; the public demo starts in English (`PANEL_DEFAULT_LOCALE=en`); outside the
      demo a Spanish browser sees Spanish (login included). Numbers / dates follow the panel
      language; supplier price READING stays es-UY. All Spanish NEUTRAL (no voseo): "tú" in the
      panel, "usted" in WhatsApp to suppliers / customers. Demo sample data stays Spanish. WhatsApp
      texts follow a new business-language setting (Spanish default). Both languages: panel guide
      for the owner, case study (docs/), video captions (EN for the README GIF, ES for YouTube and
      clients). Workana / LinkedIn texts + post draft OUTSIDE the repo
      (`C:/dev/smartops-portfolio-kit/`). Media budgets (test): README media ≤ 8 MB, Spanish
      guide screenshots ≤ 4 MB, 12 MB total. n8n workflow / node names to English in phase 12 (CLI
      import on the VM) — the user's local n8n is NOT touched (real credentials; export backup
      first when it is done). Kept from the first plan: license "all rights reserved", author
      sanchezign, screenshots light + dark (desktop 1440×900 + iPhone 15), paid-client costs with
      verified prices, no exaggerated claims, warn the user to hide their number in phone videos.
    - Milestones: M0 branches → M1 i18n infrastructure → M2 every panel text + no-literal-string +
      catalog parity + anti-voseo test → M3 API texts / business.language / alert codes + params →
      M4 E2E in English + Spanish smoke + axe in both → M5 English docs (README portfolio, docs
      index, development, architecture with Mermaid, security, costs, runbook + deploy guides in
      English, link checker in `quick`) → M6 screenshots + video / GIF — STOP for the user's review
      → M7 panel guide EN + ES → M8 kit outside the repo → M9 close.
    - M0 — DONE (2026-09-28): PR #8 green (e2e 6m39, images 4m53, integration-coverage 5m08),
      rebase-merged with the user's OK (branch `feat/phase-12-deploy` kept); branch created + pushed.
    - M1 i18n infrastructure — DONE (2026-09-28), ADR-024. API: migration `user_locale`
      (`users.locale` NULL = browser, hand-written CHECK `users_locale_chk` en/es — listed in
      migrations.test.ts), `src/common/locale.ts`, locale in the session user (login, GET
      /auth/me), `PATCH /api/v1/auth/me {locale}` (strict Zod; shared public demo account → 403;
      authz matrix regenerated: anonymous 401, both roles allow). Panel: next-intl 4.14.7 exact
      (`@swc/core` / `@parcel/watcher` = its optional extractor → allowBuilds false, prebuilt
      bindings), `src/i18n/` (`locales.ts` pure: cookie `smartops_locale` → `PANEL_DEFAULT_LOCALE`
      → Accept-Language by q-value → en; `request.ts`; `messages/{en,es}.json`; typed keys),
      `<html lang>` from the resolved language (every page now dynamic), selector (login, top bar
      md+, user menu), saved language applied after login (cookie + full load), `useChangeLocale`
      (cookie + PATCH except the shared account + reload). `createFormat(locale)` / `useFormat()`:
      "$" = business currency (UYU) in both languages, USD "US$", others their code; ratios and
      percentages built by hand (Node's ICU gives es-UY "83%" and a plain space before "PM", browsers
      U+202F — tests normalize); relative times neutral ("hace un momento", was "recién"). The old
      named exports are Spanish bindings until M2 moves every component to `useFormat()`.
      `deploy/compose.yaml` admin `PANEL_DEFAULT_LOCALE: en` + invariant (mutation-checked).
      Verified over HTTP on a production build: es browser → es, en → en, cookie wins, invalid
      cookie ignored, env en beats an es browser, cookie es beats env. Playwright stays es-UY until
      M4. Tests: API 1076 unit + 221 integration, panel 99, E2E 76 passed.

## Known issues (out of scope)
- **Phase 12 — idle reclamation risk (open until M3):** the demo stack uses ≈ 0.7 GB (+ OS).
  Oracle deems an A1 idle when, over 7 days, CPU p95, network AND memory are all < 20 %. User
  decision (2026-09-28): VM of **1 OCPU / 3 GB** (threshold 0.6 GB); measure in M3 with the OCI
  memory metric + the 25 % alarm and resize if needed — never artificial load. Note: the compose
  mem_limits add up to ~3.1 GB (caps, not reservations) — revisit after measuring.
- **Phase 12 — at the phase close:** delete the local test images
  `smartops-local/smartops-{api,admin}:m0a|m0b` (user, 2026-09-28).
- **Phase 11:** the 4 accepted audit exceptions (postcss ×2 via next 15.5, deepmerge-ts,
  mysql2 — see `security/audit-exceptions.json`) EXPIRE 2026-10-31: from that day `quick` fails
  until the dependency is updated or the exception renewed with a new justification.
- **Phase 11:** the API image is 864 MB (full prod node_modules incl. Prisma CLI for migrations,
  Debian slim). Slimming (separate migrations image, distroless) left for phase 12 if it matters.
- **Phase 11:** `main` is protected only by convention (main-guard detects, does not prevent)
  until the repo is public and a ruleset is created. Release PRs opened by `GITHUB_TOKEN` get no
  CI checks (GitHub rule).
- **Phase 11:** the v0.11.0 CHANGELOG compare link (`v0.1.0...v0.11.0`) is broken — no `v0.1.0`
  tag exists. Accepted by the user (first release only).
- **Phase 11:** GHCR package visibility (private) and repository link not verified by API: the
  `gh` token has no `read:packages` scope (add it with `gh auth refresh -s read:packages`, or
  check Profile → Packages). Anonymous pulls are refused, so they are not public.
- **Tooling caveat (phase 10 M9):** one Stryker JSON report entry (`price-math.ts`, the
  `Math.min(MAX_PRICE_DECIMALS, Math.max(MIN_PRICE_DECIMALS, …))` clamp mutated to
  `Math.min(MIN_PRICE_DECIMALS, …)`) was reported "Survived", but manually re-applying that exact
  mutant and re-running the exact Stryker command (`vitest run --config vitest.stryker.config.ts`)
  shows it fails 4 tests (exit code 1) — i.e. it IS killed in practice. Likely a reporting
  artifact of the command-runner integration (see the vitest-runner incompatibility below); the
  mutation SCORE (79.1 %) may undercount slightly. Not investigated further (time-boxed).
- **Tooling (phase 10 M9):** `@stryker-mutator/vitest-runner` 10.0.0 runs ZERO tests per mutant on
  Vitest 5 (stryker-js#6210, fix unreleased on 2026-09-27) → mutation testing uses Stryker's
  command runner (whole unit suite per mutant, slower). Switch back when a release has the fix.
- **Phase 10 M6 (still open, not requested):** the spreadsheet keyword detector does not fold
  leetspeak digit substitution ("1gnora" for "ignora") — documented by a passing test in
  `prompt-injection.test.ts` that states it explicitly. The model flag + review gate stay the
  first line of defense regardless.
- **Phase 9 M8:** demo media lives in the API's memory: after an API restart, older demo
  messages show "no se pudo descargar" until the next reset. Demo content other than the six
  samples gets the fake responders (low confidence → review), never a real model.
- **Phase 9:** the global rate limit (RATE_LIMIT_MAX 300/min per IP) is shared by every panel
  user behind one NAT; raise it for a client office with many users.
- **Phase 7 M3:** `wa:optout` (manual/off-WhatsApp) does not send a WhatsApp confirmation
  (only the in-band keyword flow does, since that is a direct reply to the contact's own
  message) — the panel (phase 9) should probably confirm to the operator instead.
- **Phase 7 M3:** `user_preferences` marketing opt-out is recorded but never checked before
  a send (no template category yet, and SmartOps sends no marketing messages today).
- **Phase 7 M3:** the opt-out instruction footer only applies when `OutboundService` is
  built with `settings` (the API and worker instances do since phase 8 M3); CLI scripts
  (`wa:send`) do not inject it — acceptable for a dev tool.
- **Phase 6 (RESOLVED in phase 8 M4 for approvals made through the panel API):** approving a `column_mapping` review moves the run back to `classified`, but
  nothing re-triggers n8n: `extract` + `catalog/ingest` must be called again (done by hand
  in the M5 pass). The panel (phase 9) must re-trigger it (call the internal flow or emit a
  new event). The same applies to other approvals that send a run back to extraction.
- **Before a real client (user, 2026-09-27):** MFA (TOTP) for panel users is the recommended
  next step after phase 8's password + session hardening (not implemented in the demo).
- **Phase 6 (RESOLVED in phase 8 M1):** `internal_order` was not routed (the receiver sent it to "otro (fin)") —
  confirmed live during the phase 7 phone test ("necesito 3 macetas" → classified, no
  notification, a real order would be lost). Promoted to a REQUIRED BEFORE PRODUCTION
  first sub-step of phase 8 (see Phase order) — not just a known issue anymore.
- **Phase 6:** the first notification of a spreadsheet run waiting for `column_mapping` reads
  "Lista procesada: 1 revisión pendiente" without the supplier name (the supplier is not
  resolved until the mapping is approved). Cosmetic.
- **Phase 6:** the WhatsApp digest text is terse — richer content planned in phase 9 (see
  Phase order).
- **Phase 6:** `notifications.template` is null: outside the 24 h window digests fall back to
  panel_only until an approved utility template is configured (no template sync from Meta).
- **Phase 6:** `integration_events.attempts` counts failed attempts only (a first-try delivery
  shows 0).
- **Phase 5 M3c:** rows with an unreadable price are listed only as a warning (not as review
  items); below the 20 % threshold they are simply not applied. Mapper and matcher reuse
  `AI_EXTRACTOR_MODEL` (no separate env). The fake matcher answers "low" for everything
  (dev/demo without golden → those rows go to review).
- **Phase 5 M4:** a supplier auto-created from the WhatsApp profile name (list without
  supplierName) is never renamed when a later list states the company name: the ingest only
  adds a `supplier_name_mismatch` warning. Renaming/merging suppliers belongs to the panel.
- Review items have no expiry: old pending items stay until superseded or resolved (stale
  ones are caught at approval time with 409 STALE_REVIEW).
- The worker process also requires `INTERNAL_API_KEY` (single env module), although only
  the API uses it.
- **Phase 5 golden review (2026-09-25):** the classifier labeled the short text "Lista
  septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU" as `price_list_full` (0.65) although
  the prompt requires an explicit signal. RESOLVED in phase 6: n8n never decides full vs
  partial; the backend uses the extraction's `listKind` (static test + ADR-015).
- Minor improvement: `ai:record-golden --dry-run` overestimates (fixed ~2,200 output tokens
  per extraction, no cache discount: $0.12 estimated vs $0.056 real). Estimate the output
  with observed tokens (+ margin) and discount prompt caching ("option B", 2026-09-25).
- Price changes by an AMOUNT ("sube 20 pesos") are not supported: the extractor leaves the
  line out and adds a warning (never computes a price).
- **Phase 5 M3a:** multi-page PDFs are still sent in ONE extraction call (no page count
  check until M3b): a dense PDF overflows max_tokens → invalid_output → review. Images
  cannot be split either.
- Documents stored before M3a have no conversion row: extraction answers CONFLICT for them
  (no backfill script).
- SheetJS comes from its CDN tarball: upgrades are manual (check cdn.sheetjs.com/advisories).
  The SheetJS BIFF8 writer used by the tests does not keep hidden rows / date formats (a
  test-data limitation, not the reader).
- Fixtures still doc-based (no real capture yet): failed status, BSUID-only sender,
  interactive, unsupported (see test/fixtures/whatsapp/README.md). Capture them with
  `wa:fixtures:capture` when they show up in real traffic.
- Transcription accuracy (real WhatsApp voice note, 2026-09-25): "sube a 14 pesos desde el
  lunes" came back as "… de lunas". Consider extending the vocabulary prompt (weekdays,
  "desde el") and a confidence/review flag in phase 5; extraction must tolerate ASR errors.
- The WhatsApp webhook stores a signed media URL (`lookaside.fbsbx.com`, short-lived) in
  `webhook_events.payload` and `messages.raw`. It expires and needs the access token, but
  it is one more reason to define retention for those tables.
- Opt-in (ADR-009): opt-out ("STOP", "BAJA") is not implemented yet — it is a
  REQUIRED part of phase 7 (see Phase order). A manual opt-in does not record who
  confirmed it (needed before the panel, phase 9).
- Outbound: no template catalog sync from Meta (`GET /{WABA}/message_templates`) — the
  phase 6 notifier uses the `notifications.template` Setting instead; no outbound media and no read receipts for inbound
  messages yet (phase 7 coexistence).
- Outbound network timeouts are retried: if Meta accepted the request but the response
  was lost, the contact may receive the message twice (WhatsApp has no idempotency key).
- AAC / AMR voice audio cannot be transcribed without transcoding (ffmpeg); they are
  skipped as unsupported_format (ADR-010). Revisit if real traffic shows them.
- Demo mode: `fake` providers (Graph API, transcription, LLM in phase 5) are rejected
  in production. The $0 public demo (phase 12) must decide how to run without a Meta
  account (e.g. an explicit DEMO_MODE that allows fakes and shows a banner).
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
- Costs: never create or enable anything that generates charges without asking first
  (see "Cost constraint").
- Deploy (phase 12): the server only runs `deploy/bin/*.sh` of a RELEASED version (the bundle
  inside its API image); `SMARTOPS_LOCAL=1` exists ONLY for `scripts/deploy/local-harness.sh`.
  Secrets live in `/etc/smartops/*.env` (600) generated on the VM — never in the repo, images,
  CI or a command line. I have no SSH access to the VM: the user runs the scripts.
- Processes (user rule, 2026-09-27): NEVER kill processes you did not start. Record the PIDs
  of what you launch and stop only those (never "every cloudflared / node" by name) — in phase
  9 a tunnel of the user was closed by mistake that way.
- Git / GitHub backup (user rule, 2026-09-24): remote `origin` =
  https://github.com/sanchezign/smartops-agent (private). At the end of EVERY milestone,
  right after its commit, run `git push` of the CURRENT branch (never `--force`).
  Any other push — other branches, force pushes, tags, deleting remote branches — must
  be asked first. Run the secrets audit (no `.env`/`.sim` tracked, no real tokens)
  before pushing.
- Phase close (user, 2026-09-27, from phase 11 on): open a PR `feat/phase-N-…` → `main` with
  `gh`, wait for the checks, and merge with **rebase-merge ONLY when the user says so** (no more
  local `merge --ff-only` + push to main; the pre-push hook refuses it). Commits must be
  Conventional Commits — the changelog is generated from them (`feat`/`fix` bump the version).
- CI: never add a real key / secret to GitHub Actions; `ai:eval` never runs in CI. New actions
  are pinned by full SHA with a version comment, tool images by `tag@sha256`; lint workflows with
  actionlint + zizmor (see docs/ci-cd.md). The user applies GitHub repository settings by hand.
- WhatsApp fixtures: `apps/api/test/fixtures/whatsapp/`
- Local WhatsApp without Meta: `wa:simulate` + `wa:fake-graph` (README "Desarrollo
  sin Meta"). New WhatsApp features must work against the fake Graph API; extend
  `fake-graph.ts` when a phase needs a new Graph endpoint.
- Prompts: `apps/api/src/ai/prompts/*.md`
- n8n workflows: `n8n/workflows/{receiver,processor,notifier,errors}.json`, exported ONLY with
  `pnpm --filter @smartops/api n8n:export` (sanitized) — never hand-copy exports with pinData.
  After changing an internal route schema or the message.ready payload, run
  `pnpm --filter @smartops/api n8n:contract` (n8n/contract.json is generated; a test checks it).
- Team phone numbers (`notifications.whatsappRecipients`) live in the DB only, never in the repo.
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
- CLAUDE.md is guarded by `test/unit/claude-md.test.ts` (key sections in order, minimum
  content, phases 1..N without gaps, size floor, and locally ≤ 15 % loss vs HEAD). Edit it with
  targeted replacements, never by rewriting the whole file from a partial copy; after
  intentional growth run `pnpm --filter @smartops/api claude-md:baseline`.
