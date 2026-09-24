# ADR-009: Opt-in required for business-initiated WhatsApp messages

Date: 2026-09-24
Status: accepted

## Decision

Every contact has `optInAt` + `optInSource` (`inbound` | `manual`). The outbound
service refuses **templates** (business-initiated messages) to contacts without opt-in
with `ErrorCode OPT_IN_REQUIRED` (HTTP 409); nothing is stored or sent.

- A contact who writes to us first gets an **implicit opt-in** (`source = inbound`,
  dated at the first inbound message) when the message is ingested. The migration
  `outbound_messages` backfills it for existing contacts.
- A **manual** opt-in (`source = manual`) is recorded only when an operator confirmed
  consent outside WhatsApp. For tests, `wa:send … --opt-in-confirmed` records it.
- The rule is checked when queueing and again right before sending.
- Free-form text is governed by the 24h customer service window, which can only be
  open if the contact wrote to us (so it implies an inbound opt-in).

## Reason

WhatsApp Business policy requires consent before a business initiates a conversation,
and sending templates without opt-in is a typical cause of quality drops, restrictions
and account bans. The account is already under review after a (likely false positive)
suspension, so the product must make non-compliant sends impossible by construction.

## Consequences

- Business-initiated flows (phase 6 notifier alerts, panel templates in phase 9) must
  target contacts with opt-in; suppliers who never wrote need a manual opt-in record.
- Opt-in evidence is minimal (timestamp + source). Recording who confirmed a manual
  opt-in, and opt-out handling (e.g. "STOP" → `optOutAt`, block templates), are pending
  (Known issues in CLAUDE.md).
- A CHECK constraint keeps `opt_in_at` and `opt_in_source` together.
