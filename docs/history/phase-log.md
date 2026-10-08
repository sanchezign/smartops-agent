# Phase log

Moved textually from the "Current phase" section of CLAUDE.md on 2026-10-06 (the file had grown
past the 150,000-character limit). Every phase and milestone as it was built, in the original
order. CLAUDE.md keeps only what is active. Newer closed milestones are appended here.


**Phases 1–11 and 13 COMPLETE and merged (v0.11.0 released; phase 13 merged 2026-10-02; release PR
#9 for v0.12.0 stays open until the first deploy; Renovate PR #6 untouched). Phase 12 (deploy $0)
continues on branch `feat/phase-12-micro`: M0 DONE; M1 DONE with an E2.1.Micro VM (A1 never had
capacity: 420 attempts) — see item 12. Plan approved 2026-10-02: M2.0 docs/decision, M2.1 light mode
in the API (DONE), M2.2 light deploy bundle (DONE), then STOP: M3 (host hardening) is run by the
user with the assistant's scripts. M3b (phase 5) and MFA (TOTP) remain recommended/required before
a real client.**

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
12. deploy ($0) — IN PROGRESS (branch `feat/phase-12-deploy` merged; now `feat/phase-12-micro`). Approved plan (2026-09-28) + user answers:
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
    - TARGET CHANGE (user, 2026-10-02, ADR-023 + ADR-025): A1 never had capacity (420 attempts, also
      after Oracle's "fully provisioned" notice); Pay As You Go discarded; an E2.1.Micro was created
      without a card: `smartops-demo-micro`, Ubuntu 24.04.5 x86_64, AD-1, subnet smartops-public,
      private IP 10.0.0.21, reserved IP 163.176.132.161 (smartops-demo.duckdns.org), Bastion
      `smartopsbastion` (allowlist = the user's /32), SSH works through a port-forwarding session.
      Measured on the VM: 954 MiB total, ~386 MiB used by the base system, ~567 MiB available, no
      swap. `launch-retry.ps1` is ON HOLD (kept, untouched; do not touch it nor ~/.oci).
    - Simulation (Docker `dind` capped at 550 MiB RAM + 2 GiB swap + 0.125 CPU; Docker itself inside
      the cap; 6 "Probar el sistema" samples): current stack with n8n → 6/6 timeouts at 240 s (swap
      567 MiB); light profile, API and worker separate → 610 MiB demand, 7.8 s median; light profile
      in ONE process → 423 MiB demand (RAM + swap), API ready in 34 s, 1.8–8.4 s per sample (median
      5.9 s), 0 OOM. Docker daemon ≈ 105–130 MiB PSS (biggest lever left; not touched). Memory tuning
      (glibc arenas, smaller heaps / Postgres) gained nothing. Idle CPU 2.59 % of 1 OCPU = 20.8 % of
      1/8; a real demo reset = 21.8 s, 3 CPU-seconds, peak 325 MiB anon + 62 MiB swap.
    - Approved plan (2026-10-02) + user answers: M2.0 decision docs (this); M2.1 light mode in the API
      (`DEMO_ORCHESTRATOR=internal|n8n`, only in DEMO_MODE; in-process orchestrator behind the same
      `N8nClient.send` seam; combined API+worker entry; parity test against the exported workflows;
      REQUIRED (user): in light mode the "Probar el sistema" samples are processed ONE AT A TIME
      (queue with concurrency 1) on top of the existing global cap; README and docs must say that the
      public demo uses the light orchestrator while the real system uses n8n); M2.2 light deploy
      bundle (compose without n8n, Postgres tuned, memory caps for 550 MiB, deploy / backup / restore
      / monitor adapted, monitor MEM threshold ~80–100 MB, harness + CI checks); then STOP before M3.
      M3 (host, run by the user with the assistant's scripts): `host-diagnose.sh` first (read-only),
      then micro profile of `host-setup.sh`: Oracle Cloud Agent keeps ONLY Compute Instance Monitoring
      (everything else off, Cloud Guard Workload Protection included; the snap stays because the agent
      needs snapd), no fail2ban (22 only reachable from the Bastion subnet), 2 GB swap kept, security
      upgrades + 04:00 reboot kept. M3b Bastion: on-demand script with a least-privilege IAM user in
      compartment `smartops` (API key WITH its own passphrase, asked on use, never in plain text; the
      narrowest policy is verified with the owner's account before creating the user) + manual
      console procedure as backup; `0.0.0.0/0` rejected (Oracle: "Do not specify an open CIDR range").
      M4 v0.12.0 + first deploy + external checks + `CpuUtilization` calibration; M5 backups + real
      restore (measure the backup's memory peak); M6 monitoring + abuse checks + bounded load smoke;
      M7 close (delete the local images, ADR/CLAUDE.md).
    - M2.1 light mode in the API — DONE (2026-10-02). `src/modules/demo/demo-orchestrator.ts`:
      `createOrchestrator` (receiver → processor → notifier over the internal API: classify, route by
      classification, extract, wait 10 s while "extracting" at most 30 times, ingest, notify, supplier
      ack; each call retried 3× 5 s apart; failures reported to `/internal/n8n/errors` once),
      `createInternalApiCaller`, `createSerialQueue` (concurrency 1, bounded; a full queue answers 429
      so the outbox retries) and `createOrchestratorClient` (drop-in for `createN8nClient`, accepts
      the event at once). Env `DEMO_ORCHESTRATOR=n8n|internal` (internal only with DEMO_MODE; then no
      N8N_WEBHOOK_SECRET needed) + `DEMO_ORCHESTRATOR_API_URL`. `src/common/shutdown.ts`: shared
      shutdown coordinator (parts stopped in parallel, one exit, longest timeout); server.ts and
      worker.ts register as parts (log is now "shutting down" with `parts`). `src/demo-server.ts` =
      API + worker + orchestrator in ONE process (DEMO_MODE only; sets DEMO_ORCHESTRATOR=internal and
      N8N_DELIVERY_ENABLED=true by default). Parity: `test/helpers/n8n-exec.ts` runs the EXPORTED
      workflows (Switch/If/Wait/`$runIndex`) against scripted answers and
      `test/unit/orchestrator-parity.test.ts` compares the call trace with the orchestrator in 9
      scenarios (verified to fail when the poll limit changes). `scripts/demo/e2e-n8n.ts` now uses
      the same orchestrator. Tests: API 1,128 unit + 223 integration (new smoke: demo-server on a
      scratch `_demo` DB, 3 samples in order, one SIGTERM stops both halves, exit 0), E2E demo spec
      green on desktop; coverage ratchet raised.
    - M2.2 light deploy bundle — DONE (2026-10-02). `deploy/compose.light.yaml` (postgres tuned for
      1 GB, migrate, seed, ONE `api` service running `node --max-old-space-size=192
      dist/demo-server.js` with DEMO_ORCHESTRATOR=internal, admin heap 96, caddy; mem caps 192 / 320 /
      128 / 64 MiB; SSE_MAX_STREAMS 100; no n8n, no worker). Profile = `DEMO_PROFILE` in demo.env
      (`init-secrets.sh --profile light|full`, default full, never changes by itself; light generates
      no n8n keys); `lib.sh` `demo_profile` / `is_light` / profile-aware `compose_for`; `deploy.sh`
      skips n8n import + restart in light; `backup.sh` dumps only smartops_demo in light and
      `restore-test.sh` accepts backups without n8n (checks JWT_ACCESS_SECRET instead of
      N8N_ENCRYPTION_KEY); `monitor.sh` default MEM_MIN_AVAILABLE_MB 100 in light (400 full);
      `postgres-init` creates the n8n role/db only when N8N_DB_PASSWORD is set; `host-setup.sh
      --profile micro|standard` (micro = default under 2 GB RAM: no fail2ban) and NEW read-only
      `deploy/bin/host-diagnose.sh` (memory, top processes, services, snaps, Oracle agent, SSH,
      firewall, Docker; no secrets) for M3. CI: `check-deploy-compose.mjs full|light` (light: no
      n8n/worker, one process, orchestrator internal, caps ≤ 768 MiB total, small-memory Postgres;
      7 mutations all caught) wired into `check-deploy-bundle.sh`; `local-harness.sh` got
      `HARNESS_PROFILE` and `HARNESS_PROJECT`. Verified: shellcheck + caddy + both compose checks,
      local harness PASSED in light (deploy 44 s, smoke through Caddy incl. SSE 6–12 ms and a sample
      through the orchestrator, backup, restore test, rollback, newer-schema refusal) AND in full
      (no regression), and the REAL light deploy.sh inside the capped simulation (550 MiB + 2 GiB
      swap + 0.125 CPU): first install 2 m 35 s, 6 samples 2.0–10.8 s (median 6.7 s), demand
      410 MiB (286 RAM + 124 swap), 0 OOM. Docs: runbook (profiles, "full only" steps, Bastion,
      idle policy), deploy/README, ci-cd, development, architecture. Test rig removed (user OK).
      NEXT = M3 (the user runs `host-diagnose.sh` then `host-setup.sh --profile micro`; the Oracle
      Cloud Agent keeps ONLY Compute Instance Monitoring), M3b Bastion script, M4 first deploy.
    - M3 prep (2026-10-02, after the user ran `host-diagnose.sh` on the VM; output kept OUTSIDE the
      repo): 602 MiB available, no swap, Docker not installed, paravirtualized disk (no iSCSI),
      base ≈ 350 MiB (oracle agent 85 + updater 23, snapd 48, fwupd 41, multipathd 20, udev 25,
      cloud-init, unattended-upgrades 11, ModemManager 6). The user already turned OFF every Oracle
      Cloud Agent plugin except Compute Instance Monitoring through the OCI CLI (the console failed:
      Custom Logs plugin "not supported" on E2.1.Micro). Approved trims in `host-setup.sh --profile
      micro` (disable + mask, idempotent, verified at the end): fwupd (+ refresh timer / service),
      multipathd, iscsid / open-iscsi, udisks2, ModemManager, rpcbind (also listened on port 111),
      open-vm-tools / vgauth; KEPT: oracle-cloud-agent (and snapd), unattended-upgrades, cloud-init,
      sysstat. SSH: PermitRootLogin no (the image had without-password), MaxAuthTries 3, and
      `AllowTcpForwarding no` in the micro profile (no n8n to tunnel to, Postgres never published;
      the Bastion tunnel is client-side and does not need it on the VM); vm.swappiness 60 on micro
      (the value the simulation used; standard keeps 10). iptables already allows 22 (OCI image
      rule; the security list limits it to the Bastion subnet).
    - M3 DONE (2026-10-03, run by the user; logs outside the repo): `host-setup.sh --profile micro`
      applied (SSH hardened, iptables 80/443, 2 GB swap, Docker 29.8.2, trims, port 111 closed);
      564 MiB available WITH Docker (dockerd 87 + containerd 41 MiB). The first run failed on the dpkg
      lock held by unattended-upgrades; fixes (fix/host-setup-apt-lock): `apt_get` waits for the lock
      (≤ 10 min, says so) with `DPkg::Lock::Timeout`; apt-daily / apt-daily-upgrade moved to 02:20 /
      02:50 (local, ±5 min; before the 03:30 backup and the 04:00 reboot; security updates kept);
      packagekit masked on micro (18 MiB). M4 (first deploy) goes BEFORE M3b (the user's IP did not
      change).
    - M4 incident (2026-10-03): the first deploy stopped at `fetch-bundle.sh`: the published
      v0.12.0 images declared `org.opencontainers.image.version=main`. ROOT CAUSE: the `build` job of
      release.yml ran docker/metadata-action with no `tags`, so the label came from the git ref; only
      the `merge` job knew the tag. fetch-bundle.sh's check was right and stays untouched. FIX
      (fix/image-version-label): the build job passes the semver tag (`type=semver,{{version}}`) to
      the metadata step; `scripts/ci/image-version-check.sh local|published` — `local` runs inside
      both container smoke scripts (EXPECTED_VERSION) BEFORE anything is pushed, `published` checks
      every platform (amd64 AND arm64) of `ghcr.io/…:X.Y.Z` after the multi-arch tags are created;
      `test/unit/image-version.test.ts` guards the wiring and the script (fake docker). Republish =
      v0.12.2 through release-please (a published tag is never rewritten: v0.12.1's tag exists WITHOUT images because the new check script lost its exec bit on Windows and the smoke ran it directly; now called with `bash`, mode fixed); v0.12.2 then published the api image but its post-publish check failed because the merge job had no checkout (script missing) and fail-fast cancelled the admin publish: merge job now checks the tag out and has fail-fast false; republish = v0.12.3. the v0.12.0 images stay in
      GHCR with the wrong label (the user may delete that package version in the GitHub UI).
    - M4 DONE (2026-10-03): v0.12.3 is ONLINE at https://smartops-demo.duckdns.org (first deploy by the
      user). Verified from the user's PC: health 200 (db up), http→https 308, Let's Encrypt cert
      (TLS 1.3, expires 31/12), HSTS / CSP / X-Frame / nosniff / Referrer / Permissions headers,
      internal and webhook routes 404, SSE first frame ≈ 50 ms (GET and POST), `demo-check.mjs`
      PASSED (photo 7.9 s, pdf 3.1, audio 6.1, spreadsheet 6.5, new spreadsheet 5.5 needs_review,
      injection 2.4 needs_review). Memory after the samples: 268 MiB available, 106 MiB swap;
      containers api 187/320, admin 78/128, postgres 38/192, caddy 36/64 MiB.
      BUG FOUND: host-setup.sh 0.12.3 wrote `OnCalendar=*-*-* 20` / `50` (`${timer##*:}` kept only the
      minutes of "02:20"); systemd rejected them, automatic updates did not run. Fixed by hand on the
      VM (02:20:00 / 02:50:00); root fix (fix/apt-timer-calendar): `deploy/lib/apt-timer.sh`
      `render_apt_timer` validates the time, `test/unit/apt-timer.test.ts` renders what host-setup.sh
      passes and has `systemd-analyze calendar` judge it (also proves it rejects the old values).
      Also learned: the Bastion SSH drops on long sessions → `-o ServerAliveInterval=30` (runbook §11);
      the user's home IP changed AGAIN → M3b is needed. GHCR token (classic, read:packages) created
      2026-10-02, expires 2026-12-31 (renew by 12-15; Healthchecks reminder check, runbook §11).
    - PLAN to close phase 12 (approved 2026-10-03; each STOP = a step of the user): R0 this fix + runbook
      (no deploy yet: the VM is already correct; it ships in 0.13.0); M3b Bastion script (PowerShell,
      least-privilege IAM user in `smartops`, API key WITH passphrase asked on use, narrowest policy
      verified with the owner's account); M5 backups to Object Storage with instance principal and a
      restore test on the user's PC — if the OCI CLI container makes the backup's memory peak risky
      with ~268 MiB free, evaluate a lighter way (OCI CLI in a venv, or the minimal SDK with instance
      principal) and choose by measurement; M6 monitoring (UptimeRobot + Healthchecks.io: monitor,
      boot, backup, restore reminder, token reminder) + bounded abuse / load checks; M7 CpuUtilization
      calibration, Mozilla Observatory, README + sales kit with the demo URL; M8 close: CLAUDE.md,
      release 0.13.0 (1.0.0 only after the separate security audit), one `deploy.sh` by the user, and
      cleanup WITH the user's OK: local images `smartops-local/*:m0a|m0b` and harness volumes
      `smartops-m2light_*` / `smartops-m2full_*`, GHCR versions 0.12.0–0.12.2, and the launcher: IAM
      user `smartops-launcher` + group + policy + API key + the Resource Manager stack in OCI AND, on
      the user's PC, `~/.oci/smartops_launcher.pem` and the [SMARTOPS] section of `~/.oci/config`
      (the whole file if it ends up empty) — until then NEVER touch ~/.oci nor launch-retry.ps1.
    - Audit gate (2026-10-03): new HIGH GHSA-vfj7-8cjw-p6xm (braces 3.0.3, no fix) blocked CI; build-time only via shadcn > ts-morph > fast-glob > micromatch, absent from both images → exception added until 2026-10-31 like the other four (all five expire together).
    - M3b Bastion on demand — WRITTEN (2026-10-03), WAITING for the user's IAM setup + first run:
      `scripts/oci/bastion-connect.ps1` (PowerShell 5.1, ASCII, runs on the user's PC): finds the public
      IPv4 (checkip.amazonaws.com or -PublicIp), sets the allowlist to exactly `<ip>/32` only when it
      differs (`oci bastion bastion update --client-cidr-list file://…`; never 0.0.0.0/0), creates an
      ephemeral ed25519 key + a port forwarding session to 10.0.0.21:22 (TTL 3 h), opens the tunnel
      and the interactive ssh (ServerAliveInterval=30, HostKeyAlias=smartops-demo-vm), and ALWAYS
      cleans up (tunnel tree, session delete, key dir). The API key has its OWN passphrase: asked
      once (hidden) and handed to the CLI via the process-only `OCI_CLI_PASSPHRASE`, never written;
      the script only READS ~/.oci/config (region) and never writes there. `-Probe` reports which
      permission is missing (GetBastion / UpdateBastion / session create+delete), `-DryRun`,
      `-TunnelOnly`. Policy to start from (verified against Oracle's policy reference): `use bastion`,
      `manage bastion … where request.operation = 'UpdateBastion'`, `manage bastion-session`; the
      reads Oracle lists for CreateSession (instances, subnets, vcns, vnics, instance-agent-plugins,
      work-requests) are added ONLY if the probe asks, then pruned one by one (the user iterates with
      the console). Tests: `scripts/oci/tests/bastion-connect.tests.ps1` (fake oci / ssh / ssh-keygen;
      25 checks, run by hand on Windows) + CI static guards `test/unit/bastion-script.test.ts`. The
      tests found a real bug: icacls left the ephemeral private key read-only so it could not be
      deleted from %TEMP% (now full control + a warning when cleanup fails). Guide:
      `docs/deploy/bastion-access.md`.
    - M3b first real runs (2026-10-03, user): `-Probe` PASSED with the initial three statements plus
      `read instance-family`, `read virtual-network-family` and `inspect work-requests` in `smartops`
      (to be PRUNED one by one with the probe). Two bugs found (fix/bastion-tunnel-retry): (1) 2 of 3
      runs failed "Permission denied (publickey)" — the session is ACTIVE before the Bastion accepts its
      key: the tunnel is retried up to 90 s (`-TunnelWaitSeconds`, backoff) and the final message tells
      "key not accepted (NOT the allowlist)" from "NETWORK or the allowlist" by ssh's own words;
      (2) typing the VM key's passphrase in the interactive ssh killed the tunnel
      (`ssh_dispatch_run_fatal`): the tunnel's ssh inherited the console — now `-n` + stdin / stdout
      redirected to files (hypothesis, to confirm on the user's PC with `-TunnelOnly` + a second
      terminal); `-SshDebug` = `ssh -v` with a sanitized log (session OCID redacted).
    - M3b second real test (2026-10-03, user): the retry works ("Permission denied (publickey)" on
      attempt 1, connected on 2). The VM connection died right after the key passphrase ("Unknown
      error") because of the INTERACTIVE ssh's options, not the tunnel nor the console: this set FAILED
      (ServerAliveInterval=30, ServerAliveCountMax=4, HostKeyAlias=smartops-demo-vm,
      StrictHostKeyChecking=accept-new, -i, -p) and this one WORKS (`-o ServerAliveInterval=30 -i <key>
      -p <port> user@localhost`). The tool, the line `-TunnelOnly` prints and the scp line now use ONLY
      the working set (guarded by a test: the `$sshOpts` line is pinned). `-SshDebug` now logs every
      attempt (success included) and what the live tunnel said until it closed. Policy pruning steps
      are in docs/deploy/bastion-access.md.
    - M3b third real test (2026-10-03, user): works but intermittently. VM journal: `Connection closed
      by 10.0.0.181` — 10.0.0.181 is the BASTION's private IP, so the Bastion drops some forwarded
      connections (right after a session activates; also the idle connection while the user types the
      key passphrase is a suspect). The `-SshDebug` log showed that the tool's own Wait-Port probe is
      a connect-and-close (the harmless `Connection closed` line at 02:44:05). Fix
      (fix/bastion-stable-tunnel): after "tunnel up" wait until the VM's sshd banner (`SSH-2.0-…`)
      answers twice in a row THROUGH the tunnel (measured; printed and logged), and retry an interactive
      ssh that ends with 255 within 60 s (up to 2 more tries, same tunnel); -SshDebug logs the stability
      wait and every interactive try (exit code, seconds). ssh-agent is documented as the option that
      removes the idle-while-typing window. 54 checks against the fake oci / ssh.
    - M5 backups — PREPARED (2026-10-03, branch `feat/phase-12-backups`), WAITING for the user's steps
      (guide `docs/deploy/backups.md`, ADR-026). Uploader measured (3 MiB upload, fake endpoint): OCI CLI
      in the pinned container 62 MiB peak RSS (cgroup 58), CLI in a venv 71–74 MiB + 768 MiB disk, SDK
      only 53 MiB + 543 MiB disk → the container stays (digest pin, no host Python, no code of ours); the
      whole pipeline is ~100 MB, the real dump 321 KiB. FOUND: the old `oci` branch of `backup.sh` could
      never work (root-owned 600 files unreadable by the image's user, `--force`, no namespace) — fixed:
      root + `--cap-drop ALL` + `--memory 192m`, `--no-overwrite`, explicit `OCI_NAMESPACE`, 3 tries, lowest
      MemAvailable logged and sent to Healthchecks; the harness runs the real script against a fake CLI
      image. Append-only: dynamic group `smartops-vm` (`instance.id`), policy = read the one bucket +
      `OBJECT_CREATE`/`OBJECT_INSPECT` on it, service principal deletes via a 30-day lifecycle rule;
      `scripts/oci/setup-backup-bucket.ps1` (idempotent, `-DryRun`, 26 checks against a fake oci) and
      `deploy/bin/backup-selftest.sh` (proves create + list work, overwrite / delete / read are refused).
      The real instance-principal path can only be proven on the VM (a dynamic group can take ~1 h);
      `BACKUP_TARGET=oci` only once the VM runs 0.13.0 (v0.12.3's script is the broken one). Bastion
      policy pruning DONE (user, 2026-10-03, `-Probe` + a real connection that worked): FINAL four statements
      for group `'Default'/'smartops-bastion-users'` in compartment smartops: `use bastion`; `manage bastion where
      request.operation = 'UpdateBastion'`; `manage bastion-session`; `read virtual-network-family` (without it the
      probe fails creating the session); `read instance-family` and `inspect work-requests` removed as not
      needed (docs/deploy/bastion-access.md). Automatic security updates VERIFIED on the real VM: 02:20/02:50
      updates + 04:00 reboot ran (kernel 6.17.0-1020 → 7.0.0-1012; pending 39 incl. 28 security → 15 with no
      security) and the demo came back by itself.
    - M5 admin step (user, 2026-10-03): no admin API key on the PC (profiles: SMARTOPS = launcher,
      SMARTOPS_BASTION). OCI Cloud Shell has NO pwsh (bash + pre-authenticated CLI; checked in Oracle's
      docs), so bucket, dynamic group, policy and lifecycle rule are created in the web console with the
      exact statements of `setup-backup-bucket.ps1 -DryRun` (guide `docs/deploy/backups.md`); the script
      stays for anyone with an admin profile. Order: age key → console resources → merge release 0.13.0
      → deploy by Bastion → backup.env, selftest, manual backup, restore test.
    - v0.13.0 RELEASED and DEPLOYED (2026-10-03): PRs #24 (M5) and #25 (docs) merged, release PR #20 merged,
      run 37149488273 green (4 native builds, both multi-arch images checked: version 0.13.0 on amd64 and arm64).
      The user deployed it on the VM: current 0.13.0 / previous 0.12.3, `demo-check.mjs` PASSED (samples 2.5–8 s,
      SSE first frame 85–123 ms), `host-setup.sh` of 0.13.0 clean (apt timers 02:24 / 02:51, no bad unit file).
    - M5 selftest FINDING (user, 2026-10-03, real VM): `backup-selftest.sh` said "write the same name again
      (--no-overwrite) … it WORKED". Verified in Oracle's CLI reference and with the official oci-cli image against
      a stateful fake endpoint: with `--no-overwrite` the CLI does a HEAD, and if the object exists it SKIPS the
      upload and EXITS 0 ("The object already exists and was not overwritten", no PUT). It was the CLI, not the
      policy (the refused `--force` already proved the policy). Fix (fix/backup-selftest-no-overwrite): the script
      compares the object's etag + size (`os object head`, OBJECT_INSPECT) before and after instead of trusting the
      exit code, after the `--no-overwrite` attempt and after every refused attempt; `backup-selftest.test.ts`
      runs it against a fake docker emulating the CLI (5 scenarios; the old script fails 4 of them, reproducing the
      user's exact output).
    - M5 REAL RESULTS (user, 2026-10-03): manual backup `20261003T203033Z-manual` ok (472K; lowest available memory
      during the backup 498 MB — far above the 268 MiB feared); restore test on the user's PC PASSED (checksums OK,
      migrations=24 users=1 products=54 messages=156, throw-away database removed). A browser download names the
      files `<folder>_<name>` (`20261003T203033Z-manual_demo.env.age`): `restore-test.sh` now accepts that prefix
      (`file_of`, the manifest is checked against the prefixed names; the harness runs the restore test a second time
      with prefixed copies). Selftest fix released as 0.13.1 (release PR #27) — needs the user's OK to merge and a
      deploy before the selftest is re-run on the VM.
    - M5 CLOSED (2026-10-03): backups append-only, real backup + real restore passed; the selftest fix and the
      restore-test prefix fix are on main (PRs #26, #28). The selftest must still be re-run on the VM after the next
      release is deployed (0.13.0's script has the old, wrong check).
    - M6 monitoring — PREPARED (2026-10-03, branch `feat/phase-12-monitoring`), WAITING for the user's accounts
      (guide `docs/deploy/monitoring.md`). Free limits verified on the pricing pages: UptimeRobot 50 monitors /
      5-min interval / 5 integrations / "hobby and non-profit"; Healthchecks.io 20 checks / 100 log entries / email.
      Healthchecks answers "200 OK (not found)" for a well-formed UUID that does not exist, so `deploy/bin/hc-test.sh`
      reads the BODY (`/log` pings change no status; `--fail <check>` proves the alert email) and never prints a URL.
      Five checks: monitor 5 min / 10 min grace, boot 365 d (only its /fail matters: the VM reboots only when an
      update needs it), backup 1 d / 3 h, restore-test 30 d / 5 d, ghcr-token **60 d / 5 d** (the old 85 + 5 would only
      alert on the expiry day, 2026-12-31). monitor.env does not exist yet: monitoring is enabled by creating it and
      running `install-units.sh`. UptimeRobot: HTTP(s) on /api/v1/health + keyword "SmartOps" on /login.
      `scripts/deploy/demo-abuse-check.mjs` (capped, ~600 requests): closed surface (401/404, 2 MB body 413), 100 health
      requests ×10 (p95 < 3 s), 6th event stream refused, shared account logout-all 403, global limit 429 + Retry-After,
      login limit still 429 with a spoofed X-Forwarded-For per attempt, optional sample burst (`--inject-burst`);
      tested against a fake demo API with three modes (strict / no limits / spoofable). `hc-test.sh` and the abuse
      check are new, so the VM gets `hc-test.sh` only with the next release (0.14.0, which also carries the selftest fix).
    - M6 REAL RESULTS (user, 2026-10-03, VM on 0.14.0): deploy OK, demo-check PASSED (samples 2.8–8.2 s), selftest PASSED
      (8 PASS), monitor.env + HC_BACKUP_URL loaded, `install-units.sh` enabled smartops-monitor.timer, hc-test PASSED
      (3 checked), backup 20261003T220059Z-manual 492K (lowest available memory 438 MB), daily backup now 03:34,
      the 3 `--fail` alert emails arrived and the checks went green, ghcr-token + restore-test armed, UptimeRobot
      "demo health" (HTTP) + "demo login page" (keyword SmartOps). `demo-abuse-check --inject-burst` on the PUBLIC demo:
      surface 401/404, 100 health requests p50 96 ms / p95 294 ms / max 448 ms, 6th stream refused, logout-all 403,
      global 429 at ~301 requests (Retry-After 56 s), login 429 at attempt 9 despite a spoofed X-Forwarded-For (no
      hints), sample cap 429 after 20, queue drained in 22 s, health 200 after. VM during the burst: 476 MB available,
      swap 231 MB, api 161/320 MiB, admin 59/128, postgres 38/192 (13.9 % CPU), caddy 32/64. The one FAIL ("2 MB body
      -> 400, expected 413") was a BUG IN THE CHECK, not in the server: a raw body was sent without
      `Content-Type: application/json`, so Express never parsed it and the login route answered VALIDATION_ERROR
      (reproduced on the local stack, then fixed; the API answers 413 over a real socket with the header — new
      `body-limit.test.ts`; the fake API of the abuse-check test now parses only JSON like Express). Found on the way:
      the API DRAINS an oversized JSON body before answering (10 s for 2.2 MB at 200 KB/s), so Caddy's
      `request_body max_size` went from 5MB to **1MiB** (= `express.json` limit, guarded by a test; a slow 2.2 MB upload
      is now refused at ~1 MiB) and local-smoke checks it through Caddy. `status.sh` printed "<no value>" as the Health
      column title (Compose has no title for .Health with `table`): it builds its own header now (test with a fake docker).
    - M6 CLOSED (2026-10-03): PR #30 merged (abuse-check content type, Caddy 1MiB, status.sh header).
    - M7 — PREPARED (2026-10-03, branch `feat/phase-12-m7`), WAITING for the user's measurements.
      Observatory (MDN HTTP Observatory v2 API, POST /api/v2/scan, algorithm v6) on the live demo: **B+ (80)**, 11 of 12
      tests pass; the only deduction is `'unsafe-inline'` in script-src (-20, Next hydration scripts). Not fixed: a
      per-request nonce CSP (middleware, `'strict-dynamic'`, every page dynamic) is a separate plan for the user to
      approve (risk: broken hydration, charts' inline styles; E2E would watch console CSP errors). CORP is "not
      implemented" with modifier 0 (no points). README, costs.md, security.md and the portfolio kit now carry the demo
      URL (https://smartops-demo.duckdns.org); `[REPO_URL]` stays pending (private repo).
      CPU calibration: Oracle's doc (checked 2026-10-03): idle = in 7 days CPU p95 < 20 % AND network < 20 % (memory only
      A1), applies to E2.1.Micro ("1/8th of an OCPU with the ability to use additional CPU resources"); it says nothing
      about stop vs terminate nor notification. `CpuUtilization` (oci_computeagent) is emitted by the Compute Instance
      Monitoring plugin INSIDE the guest (10 s samples, 6 points a minute), so it probably equals the guest's own busy%:
      `deploy/bin/cpu-calibrate.sh [minutes]` (no root; busy / steal / iowait per minute from /proc/stat deltas + p95)
      is compared with the Console metric (`docs/deploy/cpu-calibration.md`; MQL `CpuUtilization[1d]{resourceId = "…"}
      .percentile(0.95)`, intervals 1m–60m, 1h–24h, 1d). If the metric is the guest's busy%, an idle demo is far under
      20 % and the reclaim risk is real: the plan is unchanged (alerts, start the VM, restore from backup), never fake load.
      (SUPERSEDED the same day: see the keep-alive decision below.)
      DECISION (user, 2026-10-03): the demo STAYS at Observatory B+ — no nonce CSP (middleware cost on every request on a
      1/8-OCPU VM, nothing cacheable, hydration / chart risk on the portfolio's front door). Documented in docs/security.md
      ("Why the public demo stays at B+" + "Roadmap (security)"; viable on a bigger server). NOTE: the panel pages are ALREADY
      rendered per request (next-intl reads cookies() / headers() for the language), so the cost is the middleware + the
      nonce plumbing + no caching, not "making pages dynamic".
    - M7 CALIBRATION RESULTS (user, 2026-10-04, 0.15.0 deployed, status.sh clean, 497 MB available): quiet window
      00:49–01:03 UTC busy mean 3.2 % / p95 4.9 % / steal 2.5–6.8 %; activity window 01:14–01:28 busy 2.8 % / p95 3.3 %;
      Console `CpuUtilization` 1m mean for the same minutes ~5–11 % ≈ busy + steal (01:03: 4.9 + 6.8 = 11.7 → ~11), NOT 8×;
      deploy + pre-deploy backup 00:42–00:45 ~70–73 %; 1d p95 points ~2 % (03/10), ~13 % (04/10 = all of 03/10 with 4 deploys
      and every test), a normal day ~6–8 %. Conclusion in docs/deploy/cpu-calibration.md and runbook §10. `cpu-calibrate.sh`
      needs sudo on the VM (`/opt/smartops` is root-only; permissions untouched), docs and comment fixed.
    - KEEP-ALIVE LOAD (owner's decision 2026-10-04, ADR-027, branch `feat/phase-12-keepalive`, release 0.16.0): Oracle's docs
      (Always Free Resources, read 2026-10-03/04): idle = 7 days with CPU p95 < 20 % AND network < 20 % (memory A1 only), applies
      to E2.1.Micro; they do NOT say all conditions are mandatory (reads as a conjunction), the p95 granularity, whether it applies
      during the trial, stop vs terminate, or a warning. Third-party reports of Oracle's e-mail (51sec.org 2023): one week's
      notice, STOPPED not deleted, restart if the shape is available, PAYG avoids it, threshold was 10 % → 15 % → 20 %. Nothing
      found allows or forbids a keep-alive load. Design: `smartops-keepalive.timer` 03:00:00 UTC (= 00:00 Montevideo),
      RandomizedDelaySec 5 min, Persistent=false; service `timeout <min>m sha256sum /dev/zero`, Nice 19, SCHED_IDLE, IO idle,
      CPUQuota 35 %, MemoryMax 32M, PrivateNetwork, PrivateDevices, ProtectSystem=strict, /opt + /etc/smartops + Docker
      inaccessible, DynamicUser, no capabilities; switch `/etc/smartops/keepalive.env` (KEEPALIVE_LOAD on|off, KEEPALIVE_MINUTES
      1–120) read at every start via ExecCondition (exit 1 = skipped, no failure); `deploy/bin/keepalive.sh
      status|test|on|off|stop`; OFF by default; the monitor shows `keepalive off|on|on, running now` and has no CPU threshold.
      Windows in UTC (tested: longest run ends 05:05, ≥ 10 min before the apt timers 05:20/05:50, before the backup 06:30 and the
      reboot 07:00; Montevideo = UTC-3 without DST). Verified under REAL systemd 255 in a container (`jrei/systemd-ubuntu:24.04`):
      `systemd-analyze verify`, skipped when off or minutes invalid, SCHED_IDLE, only `lo`, /dev/zero readable under
      PrivateDevices + ProtectSystem=strict, root read-only, 21 CPU-s in 60 s (= 35 %), `keepalive.sh test` restores the saved file.
      `RuntimeMaxSec` does NOT apply to oneshot units (systemd.service man page): TimeoutStartSec=125min is the backstop. Trial of
      20 minutes by the owner decides 35 % (gates: samples ≤ 2× baseline, health p95 < 1 s, no alerts; else CPUQuota=25 % drop-in or
      leave off); must be ON before 2026-10-09 (7 days since the VM exists). Plan B (runbook §10, keepalive.md §4) stays either way.
    - TRIVY BLOCKER (2026-10-04): the `images` job (and release.yml) failed on CVE-2026-103111 (HIGH, libpcre2-8-0 10.42-1+deb12u1,
      fix deb12u2) in the node:24.21.0-bookworm-slim base (same digest still unpatched). Owner chose a time-boxed exception: `.trivyignore`
      with ONLY that CVE, `exp:2026-10-18`, reason + Debian tracker; mirrored in `security/audit-exceptions.json` ("imageExceptions"),
      test `image-exceptions.test.ts`; Trivy gets it mounted + `--ignorefile` + `--show-suppressed` in ci.yml and release.yml (verified
      locally: exit 1 without it, exit 0 and "ignored" with it); the loop now scans BOTH images and fails at the end (admin was never
      scanned before). Delete the exception in the same PR where Renovate bumps the node digest to one with deb12u2.
    - M8 CLOSE (2026-10-06) — phase 12 DONE in the repo. Releases 0.16.1 (security: sharp / source-map-js, node
      digest d6aa754f…, npm / npx / corepack removed from the runtime images: Trivy node-pkg HIGH/CRITICAL 9 → 2 per image,
      image size unchanged because the files stay in the base layer; shadcn moved to devDependencies and
      @modelcontextprotocol/sdk 1.30.1 → 1.32.1) and 0.16.2 (keep-alive CPUQuota 35 → 50 %), both deployed by the owner and
      verified (demo-check, abuse check, 4 containers healthy, 504 MB available). Prisma prints "failed to detect the
      libssl/openssl version" in the images (slim image without libssl; present since 0.16.0, the schema engine does not link
      OpenSSL, 24 real migrations applied): decided to leave it. ADR-028 (2026-10-06): diff-mode audit gate in PRs, Trivy a
      warning in PRs (blocking in the release), exception maximum life (CRITICAL 7 d, HIGH 30 d; the four pnpm exceptions
      shortened to 2026-10-27, the stale braces one removed), nightly scan of main + the published images (GITHUB_TOKEN with
      packages: read can pull the private images; 2 billed minutes a run), Renovate reviews the node / postgres digests daily
      without automerge. Keep-alive: the quota is per vCPU and the Console averages both (nproc = 2): plateau ≈ rest +
      CPUQuota / nproc + ~2 points of steal; trial of 2026-10-06 with 50 %: busy 22.7 % + steal 9–13 % (Console ~33–35 %),
      slowest demo sample 9.9 s, health p95 538 ms; keepalive.sh test refuses while a run is in progress. Cleanup: no
      smartops-local images or smartops-m2* volumes existed on the new laptop; launcher key and [SMARTOPS] profile removed
      locally (config backed up). Oracle Free Trial checklist and inventory: docs/runbook.md §12. Phase 14 (frontend
      clarity, UX) is next.
13. i18n + docs + portfolio — COMPLETE (merged 2026-10-02); branch `feat/phase-13-i18n-docs` (created from main after PR
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
    - M2 every panel text — DONE (2026-09-28). All visible text in `src/i18n/messages/{en,es}.json`
      (namespaces per feature; typed keys, so a missing key is a TS error). Pure modules return
      CODES, screens translate: `InputError {code, params}` (lib/number-input.ts; "inputErrors",
      shown by `useInputErrorText` — number params formatted, a "day" param = weekday name),
      review / conversation / user / demo error keys, `reviewTitle(item, text)`, demo `timeline`
      step + outcome + link keys (counts for "updated"), `recentlyResetParams`, rules
      `SECTIONS` without text (`fieldMessageKey`: dots → "_"; unit test checks every field has
      label / help / suffix in both catalogs). Page titles via `pageMetadata(key)`
      (src/i18n/metadata.ts). Number inputs per language: one decimal separator (either), the
      language's GROUP separator + 3 digits refused ("1.850" es, "1,850" en); price fields pre-fill
      without group separators ("3052,5" es, "3052.5" en). Formatter gained `weekdayName`,
      `formatWeekdayTime`, `formatShortDate`, `formatLongDay`; the old Spanish-bound exports were
      removed (every component uses `useFormat()`). Guards: eslint-plugin-i18next 6.1.5
      `no-literal-string` (mode jsx-only on src/**/*.tsx; technical attributes, translation
      callees t/tX/tX.rich, setters and `href`/`action` props excluded; chart.tsx / sonner.tsx
      ignored), `test/locale.test.ts` (catalog parity + no empty values), `test/messages-style.test.ts`
      (no voseo in es — heuristic on stressed endings with a neutral allowlist, future tense allowed,
      -rar voseo imperatives listed; no Spanish characters in en). Neutral Spanish throughout ("tú";
      "Revisa", "Escribe", "Prueba"; "recién" → "hace un momento"). Property tests run per language.
      Panel coverage ratchet raised (lines 82 / branches 74 / functions 76 / statements 81).
      Tests: panel 113, E2E 76 passed (Playwright still es-UY until M4; 2 selectors updated to the
      neutral texts).
    - M3 API texts + business language — DONE (2026-09-28), ADR-024 amendment. Setting
      `business.language` (es | en, default es; Rules → "Language of WhatsApp messages", a select)
      drives every WhatsApp text the backend composes: `src/common/business-texts.ts` (opt-out
      instruction + confirmations, supplier ack, digest lines / headline / footer, run titles;
      `businessMoney` / `businessPct` with the panel currency rule). Spanish to contacts in
      "usted" ("Responda BAJA…", "Recibimos su lista…"). English uses STOP / START (both already
      default keywords — tested). The opt-out footer text travels with the outbound input
      (`optOutInstructionText`). The panel writes alerts (`admin/alert-details.ts` whitelist →
      `details`; panel `features/catalog/alert-text.ts`), digest items (`data` →
      `features/digests/item-text.ts`) and password-policy errors (`code` →
      `users.passwordIssues`) in the panel language. Stored titles = fallback, new ones English.
      manual_attention digest items carry the structured audio fields (+ `maxSeconds` in the alert
      payload); possible_opt_out alerts carry `matched`. Model-written `warnings` stay as they are.
      Tests: API 1087 unit (+ business-texts, English digest / ack) + 222 integration (+ English
      opt-out confirmations; the reminder test now upserts its setting), panel 119, E2E 76.
    - M4 E2E per language — DONE (2026-09-28). Playwright runs in `en-US` (the panel resolves English
      from Accept-Language); every selector translated (exact catalog matches by a script, the rest by
      hand; sample data stays Spanish). `e2e/i18n-es.spec.ts` (`es-UY`): login + dashboard + reviews +
      catalog (es-UY money) + conversations + alerts + rules in Spanish, axe on each, all 3 browsers.
      `e2e/language-switch.spec.ts` (desktop): the admin's choice is saved and applied at a login in a
      fresh English browser (restored in `finally`); the shared demo operator switches by cookie only
      (a fresh browser stays English, no error toast); the login screen has its own selector. English
      selector lessons: "Name" also matches a dialog description (exact), a toast can repeat a badge
      text ("The bot answers again."), badge text includes a decorative emoji. 85 passed / 41 skipped
      (3.7 min).
    - M5 English docs — DONE (2026-09-28). README = portfolio front page (what it does, a Mermaid flow,
      engineering highlights with real numbers, stack, a short local run, docs links, license); the
      developer content moved to `docs/development.md` (Spanish headings translated, stale env rows
      fixed: NEXT_PUBLIC_API_BASE / API_PROXY_TARGET / PANEL_DEFAULT_LOCALE, DEMO_*, PANEL_PUBLIC_URL).
      New: `docs/README.md` (index), `docs/architecture.md` (Mermaid components + message sequence +
      ER core, design-choice table with ADRs), `docs/security.md`, `docs/costs.md` (prices checked
      2026-09-28 with sources; no invented WhatsApp rate), `docs/adr/README.md` (ADR list), `LICENSE`
      (all rights reserved, sanchezign). Translated to English: runbook, M1 Oracle guide, M1 retry
      guide (the script's own log lines still Spanish, quoted + glossed), n8n setup (n8n workflow /
      node names quoted as they are until phase 12). `docs/pitch.md` stays Spanish (the original
      brief). Link checker `apps/api/scripts/ci/doc-links.ts` (offline: relative targets + GitHub
      anchors, code ignored; Node type stripping) in the quick job + unit test (also checks the real
      docs). Demo-server statements are marked "being set up (phase 12)". FINDINGS (costs research):
      Meta charges service messages and in-window utility messages per message from 2026-10-01 (no
      free allowance; rates by market published by 2026-09-01) — the main pricing page still says
      non-template messages are free; Vercel Hobby is non-commercial only.
    - M6 screenshots + video — DONE (2026-09-28), WAITING for the user's review. `apps/admin/e2e/media.spec.ts`
      (MEDIA=1; not an assertion suite): English screenshots light + dark, desktop 1440×900 (dashboard,
      column picker, product history, chat) and iPhone 15 (dashboard, reviews, inbox); the demo flow
      recorded twice on a fresh E2E DB — with English captions drawn in the page (re-drawn on every
      navigation) for the GIF, and clean with measured step times → `.en.srt` / `.es.srt`. Captions in
      `e2e/media-captions.ts` (EN + neutral ES). `scripts/media/build-media.sh` (ffmpeg
      `jrottenberg/ffmpeg:7.1-alpine@sha256:8ec1ee1f…`, a tool container, not a dependency): 14 WebP
      (≈ 0.5 MB) + `demo.gif` (3.9 MB, 880 px, 7 fps) in `docs/media/` (4.2 MB total); the clean MP4
      (1.2 MB, 1440×900) + subtitles in `C:/dev/smartops-portfolio-kit/video/` (outside the repo).
      README "See it" section (GIF + `<picture>` light/dark by GitHub theme). Link checker also reads
      HTML `src` / `srcset` / `href`. `test/unit/media-budget.test.ts` (README media ≤ 8 MB,
      `docs/guide/media-es` ≤ 4 MB, all docs + public media ≤ 12 MB, no video under docs/). The phone
      video with real WhatsApp is the user's (hide the phone number).
    - Review adjustments (user, 2026-09-28, media approved): (1) demo seed classify usages now
      realistic (input 1,080–1,500, output 60–170 tokens incl. low-effort reasoning) → "Estimated
      saving US$0.1633" (45 × ≈ US$0.0036), total AI US$0.5143; only the dashboard WebPs, the GIF and
      the kit video were regenerated. (2) Panel routes in English: /reviews, /conversations,
      /conversations/opted-out, /catalog, /alerts, /rules, /users, /try (/d/<token> unchanged);
      `src/legacy-routes.ts` → permanent (308) redirects from the Spanish routes incl. sub-paths
      (next.config `redirects()`), unit test (targets exist, old folders gone, order) + E2E
      (`legacy-routes.spec.ts`); the API digest deep-link paths are English too. Local note: stale
      generated `.next/types` of the old routes broke the E2E build type check — moved (not deleted)
      to the session scratchpad. (3) The "Reiniciar demo pending" entry had already been removed in
      8eee297. (4) renovate.json: `@eslint/js` majors blocked with eslint; group `vitest` (vitest +
      @vitest/coverage-v8, every update type) after the non-major group; `test/unit/renovate-config.test.ts`;
      validated with renovate 44.107.0 --strict. PR #7 closed with a comment; PR #6 left open (to
      review at the phase close; Renovate will move vitest out of it into its own group PR). (5)
      WhatsApp pricing change in Known issues.
    - M7 panel guide — DONE (2026-09-29). `docs/guide/panel-guide.md` (EN) and
      `docs/guide/guia-del-panel.md` (neutral Spanish, "tú"): what SmartOps does, signing in
      (language, theme, sign out everywhere), home, reviews (product line, new spreadsheet format,
      the other kinds, roles), conversations (badges, reply as a person + 24 h window, pause /
      reactivate, opt-outs), catalog, alerts, rules, users, the WhatsApp summary, what SmartOps never
      does. 11 screenshots per language (desktop 1280×960, light) from the real panel: media.spec
      "guide screenshots" (MEDIA_GUIDE=en|es, language-independent selectors, locale cookie) →
      `build-media.sh --guide` → `docs/guide/media-{en,es}/*.webp` (672 KB for both; Spanish budget
      4 MB). Linked from the README and docs/README.md.
    - M8 case study + portfolio kit — DONE (2026-09-29). `docs/case-study.md` + `docs/caso-de-estudio.md`
      (problem, goal, approach, architecture, MEASURED results only, lessons, next steps). Kit OUTSIDE
      the repo at `C:/dev/smartops-portfolio-kit/` (not versioned): README (index + checklist before
      publishing: [DEMO_URL] / [REPO_URL] placeholders, hide the phone number, WhatsApp prices),
      `workana.md` (ES + EN variant), `linkedin.md` (project, Featured, headline; ES + EN),
      `post-borrador.md` (launch post ES + EN), `video/` (MP4 47 s + .en.srt / .es.srt).


14. frontend clarity (UX) — IN PROGRESS (branch `feat/phase-14-frontend-clarity`, from `main`; one milestone at a
    time, the owner reviews each). Owner decisions (2026-10-07): style "Señal" (ADR-029); in DEMO_MODE the
    public operator resolves the column-mapping review (ADR-030); credentials `demo@smartops.test` /
    `try smartops demo` + one-click sign-in + the old operator retired by the seed; demo content language
    per deployment (`DEMO_CONTENT_LANGUAGE=en|es`, public demo in English, M5); order M0–M4, M6, M7, then M5;
    the README / guide media are regenerated ONCE, at the end of M5. The exploration of three directions
    (Planilla, Señal, Mostrador) stays on the local branch `design/phase-14-exploration` (never pushed: ~38 MB
    of screenshots, the repository goes public). Before/after screenshots of every milestone live in
    `apps/admin/e2e/screens/phase-14/<label>/` (gitignored), taken by `e2e/phase14-shots.spec.ts` (axe per
    capture). Local note: Playwright's WebKit does not start on the owner's Windows PC; the opt-in project
    `iphone-chromium` (`E2E_IPHONE_CHROMIUM=1`, iPhone 15 metrics on Chromium) is used there; CI keeps the
    real WebKit "iphone".
    - M0 — DONE. ADR-029 (identity: graphite on concrete, one safety yellow `#FFC400` = "waits for a person",
      Archivo, framed 1.5 px rows, currency belongs to the content) and ADR-030; baseline screenshots.
    - M1 — DONE. Tokens in hex (light / dark) in `globals.css`, Archivo via `next/font` (CSP `font-src 'self'`),
      graphite sidebar and demo banner, framed cards, login on tokens. `test/contrast.test.ts` computes the
      WCAG contrast of every token pair (text 4.5:1; control borders, chart colors and the yellow tile edge 3:1;
      destructive on its own tint) — it caught the input border (2.92:1) and the red tint (4.48:1).
    - M2 — DONE. Home: "Pending" (yellow tiles only for counts above zero, framed in ink; errors red, never
      yellow) and "Automation" groups with visible titles; the four pending figures fit a phone's first screen;
      AI cost card marked "Sample data" in DEMO_MODE (`aiCostMode`), plain-language budget line elsewhere;
      `formatUsd` = cents (4 decimals only under one cent), `formatUsdPrecise` for chart tooltips; yellow
      counters for Reviews / Alerts in the navigation (`usePendingCounts`, same query key as the Home). The
      counter is part of the link's accessible name → E2E `navLink()` helper.
    - M3 — DONE. One framed row (`components/list-row.tsx`) for Conversations, Catalog, Alerts, Reviews; kind
      of contact as a text chip; yellow price-tag label (`.tag-shape`) for "a person is handling it"; chat
      header = a two-row grid that stays under the top bar (who answers + main action visible when a chat
      opens, also on a phone; E2E checks it and its height < 150 px); a canceled bot reply is a dashed neutral
      bubble (`statusTone`), only a failed send is red.
    - M4 — DONE. M4b: `canResolveReview(role, item, { demoMode })` — operator + DEMO_MODE + scope `run` + kind
      `column_mapping` (nothing else changes; mutation-checked; panel mirror; per-item authz matrix
      `test/e2e/authz-review-matrix.test.ts` + fixture; audited operator approval on Postgres). M4a: new
      credentials, one-click "Sign in as the demo operator", the seed retires operators that are not the
      configured one (admins made by hand untouched), Try puts the new spreadsheet first ("Start here"; only
      its Send is primary), a long contact name wraps to two lines in the chat header.
    - M6 — DONE. Product, review detail, users, opted-out list in the same style; Rules read-only shows values as
      text; an unknown address and a broken screen render INSIDE the shell (`app/(main)/[...rest]`,
      `not-found.tsx`, `error.tsx`); Uruguayan pesos show their code in English ("UYU 15.76", Spanish keeps
      "$ 15,76"); a wide table container is keyboard-focusable (axe).
    - M7 — DONE. `e2e/a11y.spec.ts`: every screen × light / dark × every browser project, zero axe
      violations (English; the Spanish pass is `i18n-es.spec.ts`); coverage ratchet raised (lines 83, functions
      78, statements 82). The media / guide specs still run against the new UI; their images are regenerated
      once, after M5.
