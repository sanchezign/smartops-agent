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
- Deploy target: $0 custom target (Oracle Cloud Always Free VM + Caddy, or Render free
  + Supabase; admin on Vercel Hobby) instead of `render` — cost constraint of the
  portfolio demo (2026-09-24). ADR in phase 12 (supersedes ADR-007).
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

## Current phase
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
5. extraction + catalog — IN PROGRESS (M1, M2, M4, M3a, M3c done; M3b required before production). Branch `feat/phase-5-extraction-catalog`.
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
     Goldens for the sheet scenarios NOT recorded yet: `ai:record-golden --dry-run --only sheets`
     = expected $0.0143 / worst $0.0990 → waiting for the user's authorization.
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

## Known issues (out of scope)
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
  the prompt requires an explicit signal. Handled in phase 6: the router uses the
  extraction's `listKind` (see Phase order).
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
- `onInboundMessage` hook (phases 6/7) runs after the message is committed: if it
  throws, the job retries but the message is then a duplicate and the hook is NOT
  called again. Phase 6 must make the hand-off durable (enqueue its own job /
  outbox) instead of calling n8n inline from the hook.
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
  phase 6 notifier needs it; no outbound media and no read receipts for inbound
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
