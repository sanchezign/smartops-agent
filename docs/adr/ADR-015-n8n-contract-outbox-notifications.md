# ADR-015: n8n contract — reliable outbox, AI-free pre-filter and anti-spam notifications

Date: 2026-09-26
Status: accepted

Extends ADR-002 (n8n orchestrates, the backend decides) with the concrete contract built in
phase 6.

## Decision

### 1. Split of responsibilities

- **Backend** (`apps/api`): security, idempotency, validation, business rules, the
  pre-filter, full vs partial (from the EXTRACTION's `listKind` with quoted evidence, never
  from the classifier label), what is notified, to whom and when, and the text of every
  outbound message.
- **n8n** (4 workflows in `n8n/workflows/`): orchestration only. It never touches the
  database and never receives message content, only ids.

| Workflow               | File             | Steps                                                                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| SmartOps · Receptor    | `receiver.json`  | Webhook `smartops-message-ready` (Header Auth `X-SmartOps-Secret`, answers immediately) → `classify` → route |
| SmartOps · Procesador  | `processor.json` | `extract` (polls `runs/:id` every 10 s while `extracting`, max 30) → `catalog/ingest` → Notificador          |
| SmartOps · Notificador | `notifier.json`  | `notifications` → (lists only) `messages/ack`                                                                |
| SmartOps · Errores     | `errors.json`    | Error Trigger → `n8n/errors` (critical alert). Set as the error workflow of the other three                  |

Every HTTP node uses the Header Auth credential `SmartOps API` (`X-Internal-Api-Key`) and
retries 3 × 5 s. The API base URL lives in a `Config` Set node (no `$env`):
`http://host.docker.internal:4000/api/v1` locally, the compose service name in the phase 12
single-VM deploy.

### 2. Backend → n8n: transactional outbox (`integration_events`)

- One `message.ready` event per inbound message (`dedupeKey = message.ready:<messageId>`,
  unique). It is written **in the same transaction** as the step that makes the message
  ready: ingest without media, media stored (image/PDF), media final state, transcription
  done / final / too long, document conversion done / failed. The pg-boss job
  `n8n-delivery` is enqueued in that transaction too (`fromPrisma(tx)`).
- Payload = ids and routing data only (`version, type, eventId, messageId, conversationId,
contactId, contactKind, messageType, receivedAt`), never text, transcripts or media.
- Delivery: POST to `N8N_RECEIVER_WEBHOOK_URL` with `X-SmartOps-Secret`. 2xx → `delivered`.
  Anything else → retry from 30 s, doubling up to 1 h, 30 attempts (≈ 24 h). Then DLQ →
  `failed` + critical `integration_error` alert. `pnpm --filter @smartops/api n8n:replay`
  re-sends failed events.
- Watchdog (cron every 5 min): `pending` events untouched for 2 h are re-enqueued;
  `delivered` events without an ingestion run after 15 min are redelivered (max 2).
- `N8N_DELIVERY_ENABLED=false` (default) keeps the events queued, which is useful before
  the workflows are published.
- Every internal endpoint is idempotent, so a redelivery never produces a second run,
  a second ingest or a second message.

### 3. Deterministic pre-filter (no AI) inside `classify`

`prefilter.ts` runs after the readiness checks and before any LLM call. Rules:

- `customer_contact` → `customer_query`;
- `non_content_type` (stickers, reactions, locations…), `media_unavailable`,
  `audio_too_long`, `audio_not_transcribed` → `other`;
- `no_price_signal`: text or transcript without digits, currency or price/stock words
  ("hola", "gracias", emojis) → `other`.

The rule is stored in `ingestion_runs.prefilter_rule` (indexed) so the dashboard can show
the savings. `extract` refuses pre-filtered runs and customer contacts (409). Voice notes
longer than `transcription.maxAutoDurationSeconds` (180 s) are not transcribed. Their
duration is read from the file (OGG/Opus granule, MP4 `mvhd`, no ffmpeg), and they get a
`manual_attention` alert instead.

### 4. Notifications: actionable only, digested and capped

- **Actionable events only**:
  - price increases ≥ `catalog.priceAlertPct`;
  - low stock;
  - pending reviews;
  - customer queries;
  - manual attention;
  - integration errors.

  A run without news goes to the panel only.

- **Recipients**: `panel` always. WhatsApp recipients come from
  `notifications.whatsappRecipients` (team waIds with opt-in).
- **Digest**: one message per recipient and window (`notifications.digestWindowMinutes`, 10).
  The job is scheduled with `startAfter` in the recording transaction.
- **Hourly cap per recipient**: `notifications.maxPerHour` (4). Excess items wait for the
  next digest.
- **Critical items** skip the window, under their own cap (`notifications.criticalMaxPerHour`, 3).
- **Channel**:
  - text if the 24 h window is open;
  - else the utility template `notifications.template`, if one is configured and the
    recipient opted in;
  - else `panel_only`.
- **Supplier acknowledgement** (`POST /internal/messages/ack`): the text is composed by the
  backend from the run report. It is off by default (`bot.supplierAck`; on in demo mode),
  only for suppliers in bot mode, and idempotent (`ack:<runId>`).

### 5. Versioned workflows without secrets

`pnpm --filter @smartops/api n8n:export` runs `n8n export:workflow` inside the container
and sanitizes the output (`scripts/n8n/sanitize.ts`). It:

- drops `pinData`, `staticData`, `meta`, tags and version info;
- keeps credentials as `{id, name}` references;
- **writes nothing** if it finds anything secret-like: Anthropic, Meta or Groq keys, long
  hex strings, any value from `apps/api/.env`, or a literal auth header.

Static tests (`test/unit/n8n-workflows.test.ts`) check that:

- every HTTP node calls an existing internal route with the right credential;
- the webhook is secret-protected;
- no pinned data is present;
- the processor and notifier never look at the classification.

The contract test (`test/integration/n8n-contract.test.ts`) plays n8n's role over HTTP.

## Reason

- n8n or the network can be down. An inline call from the worker would lose messages or
  block processing. With the outbox, a message that is stored is always delivered
  eventually, or ends visibly failed with an alert.
- Most WhatsApp traffic ("hola", "gracias", stickers, customer questions) is not a price
  list. Filtering it with deterministic rules saves tokens under a ~$5 total AI budget and
  keeps customers' messages out of the price pipeline.
- A notifier that pings the team for every event gets muted. Only actionable items,
  digests and caps keep WhatsApp alerts useful.
- Keeping every decision in the backend makes it testable in Vitest. n8n stays a visual,
  replaceable orchestrator, and the same rules hold if a workflow is edited by hand.

## Consequences

- Validated on 2026-09-26:
  - **Real Claude pass**: 7 scenarios, $0.0655 total (text, greeting, customer query, PDF →
    photo, voice note, new spreadsheet format + approval, remembered format).
  - **Real WhatsApp digest**: sent over the real Graph API to the user's phone, read.
  - **Resilience**: n8n stopped → retries → delivered after the restart; a burst across a
    restart delivered every message once, 1 run each.
- A `column_mapping` approval moves the run back to `classified`, but nothing re-triggers
  n8n. Today `extract` + `ingest` must be called again. The panel (phase 9) must do it, or
  emit a new event.
- `internal_order` is not routed yet (it ends in "otro (fin)").
- The WhatsApp digest text is terse ("SmartOps · 1 consulta de cliente. Detalle en el
  panel."). Richer, still anti-spam content is planned for phase 9.
- The n8n editor must never be publicly exposed (phase 12: tunnel/VPN or allow-listed IP).
  Only the webhook paths the backend calls may be reachable.
- `notifications.template` must be an approved utility template before business-initiated
  digests can be sent outside the 24 h window. There is no template sync from Meta yet.
