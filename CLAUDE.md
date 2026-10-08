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
DECIDED (user, 2026-10-02, ADR-023): ONE Oracle Cloud Always Free **VM.Standard.E2.1.Micro**
(1/8 OCPU, 1 GB, x86_64, no Pay As You Go, no card) running the LIGHT demo profile (ADR-025: no
n8n, API + worker + internal orchestrator in one process, Postgres, panel, Caddy) with Docker
Compose; the admin panel is served by the same VM (one origin). The "full demo with n8n" (A1 VM
2 OCPU / 12 GB, or a bigger server) is for when A1 capacity or a larger server exists.
Discarded: Pay As You Go (US$100 hold, no capacity guarantee), Render free + Supabase free (sleep,
pausing, bandwidth meter), Hugging Face Docker Spaces (paid plan required).
This is not one of the standard targets (`vercel-render` | `render`): ADR-023 supersedes ADR-007.

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
Summary, one line per phase with its status. The full original phase brief (requirements, user
decisions per phase) is in `docs/history/phase-order-detail.md`; what was built, milestone by
milestone, is in `docs/history/phase-log.md`. Status as of 2026-10-06.

1. scaffold (pnpm monorepo, docker-compose Postgres + n8n) — DONE.
2. config/env/logging + Prisma schema — DONE.
3. core integration: WhatsApp Cloud API (webhook, idempotency, media, outbound, fixtures) — DONE.
4. media normalization: Whisper transcription of voice notes (Groq free, ADR-010) — DONE.
5. extraction + catalog (`ai/` module, internal API, catalog rules, human review) — DONE.
   M3b chunked extraction of long PDFs/docx stays REQUIRED BEFORE a real client.
6. n8n multi-agent (receiver, processor, notifier, errors) + AI-free pre-filter — DONE.
7. coexistence human + bot + opt-out — DONE.
8. admin auth (JWT access + refresh, admin / operator) + orders never lost — DONE.
   MFA (TOTP) stays recommended BEFORE a real client.
9. admin UI (Next.js, SSE, review queue, conversations, catalog, rules, users, public demo) — DONE.
10. tests (coverage ratchet, authz matrix, real Postgres, n8n contract, resilience, security,
    properties, mutation, real-model eval) — DONE.
11. CI/CD (GitHub Actions, Docker images, releases, supply-chain checks) — DONE (v0.11.0).
12. deploy ($0): Oracle Always Free E2.1.Micro, light demo profile, Caddy, backups, monitoring,
    keep-alive — DONE in the repo (closed 2026-10-06; v0.16.2 deployed, keep-alive ON at 50 %). The
    owner's checks on the VM / Console that remain are listed in "Current phase".
13. i18n (panel EN + neutral ES) + English docs + screenshots/video + panel guide + case study +
    portfolio kit — DONE (merged 2026-10-02).
14. frontend clarity (UX) — IN PROGRESS (branch `feat/phase-14-frontend-clarity`): M0–M4, M6, M7 DONE; M5a and M5b
    (content as data; language-aware heuristics) DONE, M5c–M5e next. Detail: `docs/history/phase-log.md` item 14.


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
- Phase 12 deploy tooling (plan approved 2026-09-28; ADR-023 written 2026-10-02; target changed to
  E2.1.Micro + light profile, ADR-025): Oracle Cloud
  Always Free (home region São Paulo, Santiago second; E2.1.Micro VM, Bastion, Object Storage,
  Budgets), Caddy 2.11 (HTTPS + one origin), DuckDNS (free subdomain, reserved IP), age (backup
  encryption, private key only on the owner's PC), OCI CLI container (instance principal
  uploads), Healthchecks.io + UptimeRobot (monitoring), shellcheck in CI. The real WhatsApp
  instance is OUT of phase 12 (the VM only runs the public demo, without real keys).
- Light demo profile (phase 12, approved 2026-10-02, ADR-025): in DEMO_MODE only, an in-process orchestrator replaces n8n and API + worker run in one process, so the public demo fits a 1 GB E2.1.Micro; the real system keeps n8n (a parity test guards both).
- Panel i18n (phase 13, plan approved 2026-09-28, ADR-024): next-intl 4.14.7 (exact; App Router
  WITHOUT i18n routing) + eslint-plugin-i18next (`no-literal-string`, M2).
Each one gets an ADR in docs/adr/.

## Architecture decisions
Formal records live in `docs/adr/` (one line each below; ADR-023 supersedes ADR-007). The longer,
finer-grained list of per-phase decisions (pinned versions, rules per module, why) is textual in
`docs/history/architecture-decisions.md` — read it before changing the module it describes.
Add one line here for every new ADR.

- [ADR-001](docs/adr/ADR-001-pnpm-monorepo.md) — pnpm workspaces monorepo
- [ADR-002](docs/adr/ADR-002-n8n-orchestration.md) — n8n for multi-agent orchestration
- [ADR-003](docs/adr/ADR-003-pg-boss-queue.md) — pg-boss for async jobs
- [ADR-004](docs/adr/ADR-004-claude-api.md) — Claude API (Anthropic SDK) for classification and extraction
- [ADR-005](docs/adr/ADR-005-whisper-transcription.md) — Whisper-compatible speech-to-text
- [ADR-006](docs/adr/ADR-006-no-oauth.md) — No OAuth — JWT only for the admin panel
- [ADR-007](docs/adr/ADR-007-deploy-render.md) — Deploy everything on Render (Blueprint)
- [ADR-008](docs/adr/ADR-008-media-storage.md) — Media storage in Postgres (bytea) behind a MediaStorage interface
- [ADR-009](docs/adr/ADR-009-whatsapp-opt-in.md) — Opt-in required for business-initiated WhatsApp messages
- [ADR-010](docs/adr/ADR-010-transcription-provider.md) — Groq whisper-large-v3 (free plan) as the speech-to-text provider
- [ADR-011](docs/adr/ADR-011-llm-provider-models-budget.md) — LLM provider, models, spend guard and prompt-injection policy
- [ADR-012](docs/adr/ADR-012-human-review.md) — Catalog ingest rules and human review items
- [ADR-013](docs/adr/ADR-013-document-conversion.md) — Document conversion (xlsx / xls / csv / txt / docx → text)
- [ADR-014](docs/adr/ADR-014-spreadsheet-formats.md) — Spreadsheets read deterministically with remembered formats per supplier
- [ADR-015](docs/adr/ADR-015-n8n-contract-outbox-notifications.md) — n8n contract — reliable outbox, AI-free pre-filter and anti-spam notifications
- [ADR-016](docs/adr/ADR-016-human-takeover.md) — Human takeover pauses only automatic replies to the contact
- [ADR-017](docs/adr/ADR-017-opt-out.md) — Deterministic opt-out, gated at the outbound service
- [ADR-018](docs/adr/ADR-018-panel-auth.md) — Panel authentication — rotating refresh sessions, Argon2id, same-origin deploy
- [ADR-019](docs/adr/ADR-019-panel-media-auth.md) — Chat media in the panel — fetched with the Bearer, shown from blob: URLs
- [ADR-020](docs/adr/ADR-020-panel-real-time.md) — Panel real time: database triggers, one LISTEN connection per API process, SSE
- [ADR-021](docs/adr/ADR-021-public-demo-mode.md) — Public demo: DEMO_MODE with the real pipeline, fakes and no Meta
- [ADR-022](docs/adr/ADR-022-ci-cd.md) — CI/CD on GitHub Actions for a private repo on GitHub Free
- [ADR-023](docs/adr/ADR-023-deploy-oracle-micro.md) — $0 public demo on one Oracle Always Free E2.1.Micro
- [ADR-024](docs/adr/ADR-024-panel-i18n.md) — Panel in English and Spanish with next-intl (no i18n routing)
- [ADR-025](docs/adr/ADR-025-light-demo-profile.md) — Light demo profile (in-process orchestrator, API + worker in one process)
- [ADR-026](docs/adr/ADR-026-append-only-backups.md) — Append-only encrypted backups to Object Storage, uploaded by a pinned OCI CLI container
- [ADR-027](docs/adr/ADR-027-keepalive-load.md) — A nightly keep-alive CPU load so the demo VM does not look idle to Oracle
- [ADR-028](docs/adr/ADR-028-security-alert-policy.md) — Security alerts: pull requests block what they introduce, a nightly scan owns what exists
- [ADR-029](docs/adr/ADR-029-panel-visual-identity.md) — Panel visual identity "Señal": graphite, one safety yellow for what needs a person
- [ADR-030](docs/adr/ADR-030-demo-operator-resolves-column-mapping.md) — In DEMO_MODE the public operator can resolve the column-mapping review

## Current phase
**Phases 1–13 are COMPLETE (phase 12 closed in the repo 2026-10-06). Phase 14 (frontend clarity) is IN PROGRESS on `feat/phase-14-frontend-clarity`: M0–M4, M6, M7 done; M5a–M5b done, M5c–M5e next.**
Phase 14 (owner decisions 2026-10-07): style "Señal" (ADR-029), demo operator resolves column_mapping in
DEMO_MODE (ADR-030), credentials demo@smartops.test / "try smartops demo", content language per
deployment (DEMO_CONTENT_LANGUAGE=en|es, public demo in English). Order: M0–M4, M6, M7, then M5 (content
language); the README media are regenerated once, at the end of M5. One milestone at a time, the owner
reviews each. The exploration branch `design/phase-14-exploration` stays LOCAL (never push: ~38 MB of
screenshots, the repo goes public).
Everything already finished (what was built, decisions, measurements, incidents, real results) is
in `docs/history/phase-log.md` — one entry per phase and milestone, textual. Read it only when you
need the detail of a closed milestone (see "History" at the end of this file).

Active state (2026-10-06):
- Public demo ONLINE: https://smartops-demo.duckdns.org — one Oracle Always Free E2.1.Micro,
  light profile (ADR-023, ADR-025), v0.16.2 deployed. Phase 12 log: `docs/history/phase-log.md`
  item 12.
- Keep-alive load (ADR-027, `docs/deploy/keepalive.md`): ON since 2026-10-05, `CPUQuota=50%` since
  0.16.2 (trial of 2026-10-06 passed: Console ~33–35 %, slowest sample 9.9 s, health p95 538 ms).
- Release PR #45 (0.16.3) is left open on purpose: it ships together with the Perl fix (Renovate
  opens the digest PR for node/postgres daily, no automerge; the owner merges). Renovate PR #6
  stays untouched until the owner reviews it.
- Security alerts policy (ADR-028): PRs block only what they introduce; the nightly scan
  (security.yml, 03:30 Montevideo) owns what exists and turns RED on a finding (check it still runs:
  docs/ci-cd.md, "Is the nightly scan still running?").

Next task: **phase 14 — frontend clarity (UX)**, after closing phase 12 and before the final security
audit and making the repo public. Input: the owner's list of pain points from the live demo. Plan it
with Opus + high effort (no code before the plan is approved).

Owner's checks still open for phase 12 (nothing to code):
- 2026-10-07: Console `CpuUtilization` plateau (~33 %) and daily p95 (expected ≥ ~30 %).
- Before 2026-10-28: the Oracle Free Trial checklist, `docs/runbook.md` §12 (every OCI resource,
  whether it is Always Free, the Object Storage limit that deletes everything above 20 GB, the
  reserved IP). Repeat it on 2026-10-29.
- GHCR package versions 0.12.0–0.12.2 (wrong label / no images): the owner deletes them in the
  GitHub UI.
- OCI Console, launcher leftovers: delete the IAM user `smartops-launcher` (API key, group,
  policy). The Resource Manager stack `smartops-demo-vm` and `scripts/oci/launch-retry.ps1` stay
  (A1 retry ON HOLD). Done locally 2026-10-06: the key `~/.oci/smartops_launcher.pem` and the
  `[SMARTOPS]` profile of `~/.oci/config` are gone (backup `~/.oci/config.bak-before-launcher-removal`).
  NEVER delete the `~/.oci` folder or the `[SMARTOPS_BASTION]` profile: `scripts/oci/bastion-connect.ps1`
  uses it.
- Docs still pending: `[REPO_URL]` in the portfolio kit (private repo); the demo stays at
  Observatory B+ (no nonce CSP, decided 2026-10-03).
- No release 1.0.0 until the SEPARATE full security audit.

Dates that will bite:
- 2026-10-13: the seven Perl Trivy exceptions (perl-base 5.36.0-7+deb12u3: CVE-2026-13221, -42496,
  -8376, -42497, -48962, -57432, -57433; `.trivyignore`, mirrored in `security/audit-exceptions.json`
  → "imageExceptions") expire. Delete them in the same PR where the node base image digest has
  perl-base 5.36.0-7+deb12u4. The CVE-2026-103111 (libpcre2) exception was removed on 2026-10-06
  (digest d6aa754f… brings deb12u2).
- 2026-10-27: the four audit exceptions in `security/audit-exceptions.json` expire together
  (postcss ×2, deepmerge-ts, mysql2; shortened from 10-31 to fit the 30-day HIGH limit, ADR-028;
  the braces one was removed 2026-10-06). `quick` (diff mode) only fails for a CHANGE that
  introduces such a finding; the nightly scan (security.yml) is what goes red.
- ~2026-10-28: the Oracle Free Trial ends (the Console shows the exact date): `docs/runbook.md` §12.
- 2026-12-31: GHCR read token expires (renew by 2026-12-15; Healthchecks reminder check).

Required BEFORE a real client (not part of the demo): phase 5 M3b chunked extraction, MFA (TOTP)
for panel users, the separate full security audit (also before the repo goes public), media
retention policy, a real WhatsApp instance (out of phase 12).


## Known issues (out of scope)
- **WhatsApp pricing change (Meta, effective 2026-10-01):** service messages and utility messages
  inside the 24 h customer service window become PAID per message (no free allowance; rates by
  market, Uruguay = "Rest of Latin America"; Meta's main pricing page still said they were free on
  2026-09-28 — see docs/costs.md). BEFORE ANY TEST WITH A REAL NUMBER after that date, check the
  current prices. The Meta account has NO payment method (confirmed by the user, 2026-09-28): a
  paid message fails instead of being charged — expect sends (acks, opt-out confirmations,
  digests, panel replies) to fail, not to cost money.
- **Phase 13 M3:** the extraction / column-mapping `warnings` shown in reviews are written by the
  model (Spanish prompts) and a failed-read `detail` is technical English: shown as they are in
  both panel languages (data, not interface text).
- **Phase 12 — keep-alive load (ADR-027):** the idle-reclamation risk was calibrated 2026-10-04
  (the Console metric is the guest's busy% plus steal; the quiet demo sits at ~3 % busy) and a
  nightly keep-alive load has been ON since 2026-10-05. Open: its `CPUQuota` was measured on a
  guest with nproc=2 (Console plateau ~25 %, daily p95 2026-10-05 ~24.7 %, ~5 points of margin over
  Oracle's 20 % threshold) → adjust it (next task). If Oracle reclaims the VM it is STOPPED (not
  deleted) per third-party reports: alert + start it from the Console (runbook §10 plan B);
  backups live off the VM. The earlier text of this entry is in
  `docs/history/resolved-issues.md`.
- **Phase 11:** the 4 accepted audit exceptions (postcss ×2 via next 15.5, deepmerge-ts,
  mysql2 — see `security/audit-exceptions.json`) EXPIRE 2026-10-27 (30-day HIGH limit): after that
  a change introducing them fails `quick`, and the nightly scan fails, until the dependency is
  updated or the exception renewed (max 30 days for HIGH, 7 for CRITICAL) with a new justification.
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
- **Before a real client (user, 2026-09-27):** MFA (TOTP) for panel users is the recommended
  next step after phase 8's password + session hardening (not implemented in the demo).
- **Phase 6:** the first notification of a spreadsheet run waiting for `column_mapping` reads
  "Lista procesada: 1 revisión pendiente" without the supplier name (the supplier is not
  resolved until the mapping is approved). Cosmetic.
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
- Outbound: no template catalog sync from Meta (`GET /{WABA}/message_templates`) — the
  phase 6 notifier uses the `notifications.template` Setting instead; no outbound media and no read receipts for inbound
  messages yet (phase 7 coexistence).
- Outbound network timeouts are retried: if Meta accepted the request but the response
  was lost, the contact may receive the message twice (WhatsApp has no idempotency key).
- AAC / AMR voice audio cannot be transcribed without transcoding (ffmpeg); they are
  skipped as unsupported_format (ADR-010). Revisit if real traffic shows them.
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
- Languages (user, 2026-09-28): the REPOSITORY is in English (code, comments, commits, README,
  technical docs, ADRs, CLAUDE.md, runbook); the user is addressed in Spanish. The panel is
  English + neutral Spanish ("tú", never voseo): every visible text in
  `apps/admin/src/i18n/messages/{en,es}.json` (ESLint `i18next/no-literal-string`, catalog parity
  and anti-voseo tests), pure modules return codes; numbers / dates through `useFormat()`.
  WhatsApp texts in `apps/api/src/common/business-texts.ts` (business language; Spanish "usted").
  Sample / demo data stays Spanish. Panel routes are English (`/reviews`, `/conversations`…);
  the old Spanish ones only live in `src/legacy-routes.ts` as redirects.
- Docs: index `docs/README.md`; relative links checked offline in CI (`doc-links.ts`); README
  media only from `media.spec.ts` + `scripts/media/build-media.sh` (budgets tested); the portfolio
  kit and videos live outside the repo (`C:/dev/smartops-portfolio-kit/`).
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
- Local WhatsApp without Meta: `wa:simulate` + `wa:fake-graph` (docs/development.md,
  "Development without Meta"). New WhatsApp features must work against the fake Graph API; extend
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
- CLAUDE.md size (user, 2026-10-06): this file is loaded in every session, so it must stay small
  (guard: ≤ 45,000 characters). When a milestone closes, its detail moves TEXTUALLY to
  `docs/history/phase-log.md`; "Current phase" only holds what is active (one line + link for
  what is closed). Resolved Known issues go to `docs/history/resolved-issues.md`. A new ADR gets
  one line in the "Architecture decisions" index.

## History (docs/history/)
Closed work lives outside this file so it is not loaded in every session. Read it ONLY when you
need the detail of something finished (why a decision was taken, measured numbers, an incident,
a user decision of a past phase), never by default:
- `docs/history/phase-log.md` — every phase and milestone as it was built (the old "Current phase").
- `docs/history/phase-order-detail.md` — the original brief of each phase (requirements, user rules).
- `docs/history/architecture-decisions.md` — the long list of decisions per phase (the ADRs in
  `docs/adr/` are the formal records; this has the finer-grained ones).
- `docs/history/resolved-issues.md` — Known issues already resolved or superseded.
- Index and rules: `docs/history/README.md`.
