# Human + bot coexistence for a real client: two paths

SmartOps supports two ways for a human operator to talk to contacts on the same WhatsApp
number the bot uses. Which one applies to a real deployment depends on whether the client
wants to keep using the WhatsApp Business **app** on their phone.

The demo (this repo, Meta test number) cannot exercise real coexistence — see
"Why the demo cannot test this" below. Everything in this guide is the path for an actual
client with a real number.

## Path A — Dedicated API number + panel replies (recommended default)

The client's number is used **only** through the Cloud API. Nobody opens the WhatsApp
Business app for it. Every human reply — a person answering a customer or a supplier from
the team — goes through the SmartOps admin panel (phase 9; `wa:reply` today), which is
exactly what phase 7 already implements (`ConversationModeService`, human takeover,
`Message.purpose`).

**Requirements:**

- A WhatsApp Business Account (WABA) and a phone number registered directly for the Cloud
  API (Embedded Signup or manual registration) — no coexistence, no Tech Provider status,
  no BSP.
- The number can be brand new; it does not need history in the WhatsApp Business app.

**Costs (Meta, as of this writing):**

- No monthly platform fee from Meta itself for Cloud API usage.
- Per-message pricing since 2025-07-01: business-initiated template messages are billed
  per message (rate depends on recipient country and template category); replies inside
  the 24 h customer service window are free, with no cap.
  ([Meta pricing docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing))
- A phone number for WhatsApp Business (a SIM or a virtual number capable of receiving the
  verification code) — a few dollars a month depending on the provider; **to confirm** for
  the specific country.

**Pros:** simplest to operate, no extra vendor, no coexistence limitations (group chats,
disappearing messages, view-once, broadcast lists all keep working normally in the app
because the app is simply not used for this number). **Cons:** the team must adopt the
panel instead of their phones for this number.

## Path B — Coexistence with the WhatsApp Business app

The client keeps using the WhatsApp Business app (and supported companion devices) on
their existing number, side by side with the Cloud API. `smb_message_echoes` mirrors what
a person sends from the app back into SmartOps (already implemented, phase 7 M2); a
message sent from the panel is delivered through the Cloud API as usual.

**Requirement (per Meta's official docs):** coexistence is only available through
**Embedded Signup run by a Solution Partner or Tech Provider** — not by a plain Cloud API
developer app like this project's. Two ways to get there:

### B.1 — Use a BSP that is already a Tech Provider (e.g. 360dialog)

The client's existing WhatsApp Business app number is onboarded through the BSP's
Embedded Signup flow, which supports the "connect an existing account" coexistence option.
SmartOps keeps talking to the Cloud API exactly as it does today (no code changes) —
what changes is who runs the onboarding UI on the client's behalf.

- **Cost (360dialog, 2026, to confirm at contract time):** from **€49/month** per number
  (Regular plan) plus Meta's per-message fees, zero markup over Meta's official rates,
  per 360dialog's published pricing
  ([360dialog pricing](https://360dialog.com/pricing)). Premium (€99/mo) and high-throughput
  (€299/mo) tiers exist for higher volume/SLA needs.
- No business verification or app review needed on our side — the BSP is already the Tech
  Provider.
- **Coexistence limitations** (Meta's reference,
  [Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)):
  group chats are not synchronized; disappearing messages, view-once messages and live
  location are disabled for 1:1 chats after onboarding; broadcast lists are disabled;
  WhatsApp for Windows/WearOS companion clients are not supported; the number is capped at
  20 messages/second; history sync must complete within 24 h of onboarding or the number
  must be re-onboarded.

### B.2 — Become a Tech Provider directly

SmartOps' own Meta app applies for Tech Provider status.
([Meta's Tech Provider guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers))

- Requires **Meta business verification** (2–5 business days typically, up to 14; legal
  business name, address, phone, email and website must match 2–3 supporting documents)
  and an **app review** (icon, privacy policy, category, a video demonstrating sending
  messages and creating templates, plus justification for the
  `whatsapp_business_messaging` and `whatsapp_business_management` permissions).
- **Cost:** Meta does not appear to charge for Tech Provider status itself; a credit card
  is required on the WhatsApp Business Platform account for per-message billing. **To
  confirm** whether any new fee applies at application time, and the exact current review
  turnaround.
- Only worth it if SmartOps expects to onboard **multiple** client numbers with
  coexistence over time; for a single client, path B.1 is simpler and faster.

## Why the demo cannot test this

Our Meta test number is a plain Cloud API number created for development — it was never
in the WhatsApp Business app, and our app is a regular developer app, not a Solution
Partner or Tech Provider. Coexistence has no test-number path in Meta's docs. So the demo
and this repo's automated tests use:

- **Path A**, fully real: `wa:reply` / the future panel, tested against the real test
  number (text replies are free inside the 24 h window).
- **Path B**'s wire format only: `wa:simulate echo` + 4 fixtures built from Meta's
  `smb_message_echoes` / `revoke` / `edit` reference
  (`test/fixtures/whatsapp/echo-*.json`, marked "doc-based" — not a real capture). The
  parser and the human-takeover logic are the same code that would run against a real
  onboarded number; only the webhook delivery is simulated.

**Before turning on Path B for a real client:** capture real `smb_message_echoes` /
`smb_app_state_sync` / `account_update` (`PARTNER_REMOVED`) payloads once the client's
number is onboarded (`pnpm --filter @smartops/api wa:fixtures:capture`), and replace the
doc-based fixtures. Re-run the phase 7 test suite against them before going live.

## Which one should a new client pick?

Default to **Path A**. Recommend **Path B.1** only when the client (or their team) is
attached to using their phone for this number and cannot move fully to the panel. Path B.2
is a business decision (recurring cost of onboarding many numbers vs. 360dialog's
per-number fee), not a technical one — SmartOps' code does not change either way.
