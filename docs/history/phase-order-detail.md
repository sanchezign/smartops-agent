# Phase order — original detail

Moved textually from the "Phase order" section of CLAUDE.md on 2026-10-06. The original brief of
each phase, including user decisions added along the way. CLAUDE.md has the one-line summary.

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

