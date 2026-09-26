# ADR-016: Human takeover pauses only automatic replies to the contact

Date: 2026-09-26
Status: accepted

Amends the message flow in CLAUDE.md ("if conversation is in HUMAN mode: stop (no bot
action)").

## Decision

### What human mode pauses

Only **automatic replies to that contact**: the supplier acknowledgement and any future bot
answer. Every outbound message carries a `purpose` (`messages.purpose`):

| purpose             | Example                         | Human mode | Opt-out (phase 7 M3) |
| ------------------- | ------------------------------- | ---------- | -------------------- |
| `auto_reply`        | supplier ack, bot answers       | paused     | blocked              |
| `compliance`        | opt-out / opt-in confirmation   | not paused | allowed (the reply)  |
| `team_notification` | digest to a team member         | not paused | blocked              |
| `human`             | a person's reply from the panel | —          | allowed in window    |

NOT paused: media download, transcription, conversion, classification, extraction, catalog
ingest and team notifications. n8n workflows do not change: the gate lives in the backend
(`send()`, the outbound worker and the ack).

### State machine (`src/modules/conversations/conversation-mode.ts`, pure)

`bot` ↔ `human` with `humanUntil` (null = until manual reactivation):

- a human message (panel reply or WhatsApp Business app echo) → `human` until
  now + `coexistence.humanTakeoverMinutes` (Setting, default 120). A later human message only
  EXTENDS it. An indefinite pause stays indefinite.
- manual pause (minutes or indefinite), manual resume;
- timeout → `bot`, only if `humanUntil` really passed;
- contact messages never change the mode;
- a late echo written before the last change back to bot does not pause again;
- a message received while a person handled the chat gets no delayed automatic reply
  (`autoReplyAllowed`: received ≥ `modeChangedAt`).

Every change is stored in `conversation_mode_changes` (append-only: from/to, reason, actor
user or label, message).

### Races

- **Takeover while a bot message is queued:** the change of mode, the history row, the
  cancellation of pending unclaimed `auto_reply` messages (status `canceled`, errorCode
  `human_takeover`) and the reactivation job are ONE transaction holding the conversation row
  lock (`SELECT … FOR UPDATE`).
- **Worker:** right before calling Meta it claims the message (`claimed_at`) under the same
  lock and re-checks the mode; an `auto_reply` in a human conversation is cancelled instead.
  Remaining gap, by design: a message already claimed (in flight to Meta) cannot be recalled;
  for app echoes the gap is the webhook latency (seconds).
- **Simultaneous events:** all go through the same lock; `humanUntil` never shrinks; echoes are
  idempotent by wamid (M2).
- **Clock:** the timeout counts from when the server sees the event, not Meta's timestamp.
  pg-boss job `conversation-bot-resume` with `startAfter = humanUntil`, enqueued in the
  takeover transaction; stale jobs (extended or resumed by hand) are no-ops. Sweeper cron
  `conversation-mode-sweeper` every 5 min reactivates expired conversations whose job was lost.

## Reason

- Processing a list sends nothing to the contact, so it cannot interfere with the person's
  conversation. A price the supplier sends is valid even if a person is chatting; pausing the
  pipeline would leave the catalog stale, build a backlog and hide price/stock alerts, and the
  person benefits from the extraction (review items) while chatting.
- Automatic replies are exactly what can contradict or interrupt the person, so they are the
  only thing that pauses.
- A single lock for takeover and claim turns the race into two well-defined outcomes (cancelled
  before Meta, or already in flight) instead of an unknown one.

## Consequences

- `messages.purpose` is required for outbound messages (CHECK `messages_purpose_chk`, migration
  `conversation_modes`; keep it when editing Message). Existing rows were backfilled.
- New message status `canceled` (outbound never sent; final).
- CLI `pnpm --filter @smartops/api wa:conversation status|pause|resume` stands in for the panel
  buttons until phase 9 (who: `--by`, recorded as `cli:<name>`).
- The panel (phase 9) shows the mode badge, who took over and until when, cancelled bot
  messages greyed out, and pause/resume buttons backed by `ConversationModeService`.
