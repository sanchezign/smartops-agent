# ADR-017: Deterministic opt-out, gated at the outbound service

Date: 2026-09-26
Status: accepted

Closes the ADR-009 known issue ("opt-out is not implemented yet") required by the WhatsApp
Business Messaging Policy before production.

## Decision

### Detection: no LLM

`src/modules/optout/optout-detector.ts` (pure, unit tested): a message opts a contact OUT
or back IN only when the **whole message** (after stripping optional "por favor" / "gracias")
equals a configured keyword (`optOut.keywords` / `optIn.keywords` Settings, default
`BAJA/STOP/CANCELAR/UNSUBSCRIBE` and `ALTA/START`), or matches one of a small fixed set of
explicit phrases in a **short** message (≤ 12 words). "baja el cemento 10%" never matches. A
second, looser set of phrases ("ya no trabajo con ustedes"…) is flagged `possible_opt_out`
(an `Alert`, reviewed by a human) instead of applied automatically.

Run **in the worker, at ingestion**, not in n8n or the extraction pre-filter: it must work
even if n8n or the AI budget is unavailable. `createOnComplianceMessageInTx` is called in
the SAME transaction as the inbound message that triggered it (atomic, like the phase 7
human takeover):

- `opt_out` on an already opted-out contact, or `opt_in` on one that was never opted out, is
  a no-op (no duplicate event, no duplicate confirmation).
- Otherwise: `Contact.optOutAt/optOutSource` is updated, an append-only
  `ContactConsentEvent` row is written, and ONE compliance reply is queued
  (`purpose: "compliance"`, idempotency key `optout-confirm:<messageId>`) — always inside
  the window, since the contact just wrote to us.

### Effect: gated at the outbound service, by `Message.purpose`

Opt-out blocks only messages **we** send, and only some of them:

| purpose                | Opted-out contact                                                           |
| ---------------------- | --------------------------------------------------------------------------- |
| `auto_reply`           | blocked (`OPTED_OUT`, 409)                                                  |
| template (any purpose) | blocked                                                                     |
| `team_notification`    | blocked                                                                     |
| `compliance`           | allowed (the one reply above)                                               |
| `human`                | allowed (a person may still reply inside the window, panel shows a warning) |

Checked twice, like the window/opt-in rules: once in `send()` (before queuing) and again in
`processOutbound()` under the conversation lock, right before calling Meta (a contact may
opt out while the message waits in the queue).

**Independent of `Contact.optInAt`** (ADR-009): an inbound message keeps granting the
implicit opt-in for templates, but never clears an opt-out. Re-enabling needs an explicit
`ALTA`/`START`, or a manual `wa:optout in` (off-WhatsApp request).

### Opt-out is scoped to OUTBOUND messages only

**An opted-out supplier's price lists are still ingested and update the catalog** — the
extraction/catalog pipeline never checks `optOutAt`. Only the acknowledgement
(`supplier-ack.ts`) is skipped (`reason: "opted_out"`). This is intentional: the policy is
about what we send to a person, not about whether we may still read what they send us.

### Instructions and reminders

The opt-out instruction ("Respondé BAJA si no querés recibir más mensajes automáticos.") is
appended to an `auto_reply` text message the first time, then at most every
`optOut.instructionReminderDays` (Setting, default 30). Checked and set atomically inside
`OutboundRepository.createOutboundInTx`'s own transaction (a conditional `updateMany` on
`Contact.optOutInstructionSentAt`), so two concurrent auto replies never double-append it.

### `user_preferences` webhook (informational)

Meta's `user_preferences` field (`category: "marketing_messages"`, `value: "stop"|"resume"`)
is parsed and stored on `Contact.marketingOptOutAt`. It gates nothing today (SmartOps sends
no marketing messages), it is kept for completeness and for when message templates are
classified by category. Error code `131050` ("recipient opted out of marketing") is mapped
to a new permanent `SendErrorCategory` (`recipient_opted_out`).

## Reason

- The policy requires "clear instructions" and honoring every opt-out request; it does not
  mandate an LLM, a specific keyword list, or forbid a confirmation reply.
- Deterministic detection is auditable, testable exhaustively, and costs $0.
- A single gate at the outbound service (rather than scattered checks in every caller)
  guarantees no future feature can accidentally message an opted-out contact.
- Scoping the block to outbound-only keeps opt-out orthogonal to the core business value
  (keeping the catalog current): a supplier who opted out of automated replies is still a
  supplier whose prices matter.

## Consequences

- Migration `opt_out`: `Contact.optOutAt/optOutSource/optOutInstructionSentAt/marketingOptOutAt`
  (CHECK `contacts_opt_out_chk`, paired with `optOutSource` like ADR-009's opt-in pair — keep
  it when editing Contact), `ContactConsentEvent` (append-only), `AlertType.possible_opt_out`.
- CLI `pnpm --filter @smartops/api wa:optout status|out|in` (manual/off-WhatsApp opt-out,
  requires `--reason` and `--by`) stands in for the panel's "opted-out contacts" screen
  until phase 9.
- The panel (phase 9) must show: opted-out contacts, who/when/why, and a manual toggle with
  a mandatory reason (already enforced by the CLI and by `ContactConsentEvent.note`).
- Not implemented: syncing `user_preferences` into an actual send-time check (moot until
  templates carry a category), and there is no template catalog sync from Meta yet (phase 6
  known issue) to know which templates are "marketing" vs "utility".
