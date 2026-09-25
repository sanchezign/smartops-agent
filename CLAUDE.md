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
    SECURITY (user, 2026-09-26): the n8n editor must NEVER be publicly exposed — reachable only
    through a tunnel/VPN or an allow-listed IP, on top of the n8n login. Only the webhook paths
    the backend calls may be reachable (and in the single-VM compose they stay internal).
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
**Phase 5 complete (2026-09-26), merged to `main`. Phase 6 (n8n multi-agent) IN PROGRESS on
`feat/phase-6-n8n`. M3b remains required before production.**

6. n8n multi-agent — IN PROGRESS. Approved plan (2026-09-26) + user answers: customer contacts →
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