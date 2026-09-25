# WhatsApp webhook fixtures

Sample `messages`-field payloads used by unit, e2e and integration tests.

## Real payloads (captured 2026-09-25, phase 3 M5)

Captured from real Meta traffic (test number, fictitious content) and anonymized with
`pnpm --filter @smartops/api wa:fixtures:capture` (scripts/fixtures/anonymize-webhook.ts).
Identifiers are deterministic fakes: contact phone `59899000111`, BSUID
`UY.1000000000000001`, business `phone_number_id` `100000000000001`, WABA
`200000000000002`, display phone `15550000000`, media ids `900000000000000N`, wamids
`wamid.ANON_*`, profile name `Test Supplier`, media URL `hash=ANONYMIZED`. Message bodies,
filenames, mime types, sha256 and timestamps are real (fictitious test content).

| File                                                            | Content                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `message-text.json`                                             | inbound text                                                   |
| `message-image.json`                                            | inbound photo (WhatsApp converts it to image/jpeg; no caption) |
| `message-document.json`                                         | inbound PDF (`lista-prueba.pdf`)                               |
| `message-audio.json`                                            | inbound voice note (`audio/ogg; codecs=opus`, `voice: true`)   |
| `status-sent.json`, `status-delivered.json`, `status-read.json` | statuses of one hello_world template (same wamid)              |
| `field-security.json`                                           | `security` field (`PIN_RESET_SUCCESS`) — ignored by the API    |

What real payloads showed (vs. the docs): media objects include a signed `url`
(lookaside.fbsbx.com) and the webhook `sha256` is **base64** (the media API returns
**hex**); statuses include a `contacts` array; `pricing.type` (e.g.
`free_customer_service`); `from_user_id` / `recipient_user_id` (BSUID) are always present.

## Doc-based payloads (no real capture yet)

`status-failed.json`, `status-delivered-bsuid.json`, `message-bsuid-only.json`,
`message-interactive.json`, `message-unsupported.json`, and `dashboard-test-message.json`
(Meta's own App Dashboard "Test" sample). Replace them with real captures when those
cases show up in real traffic.

Never commit real phone numbers, names, BSUIDs, wamids, media ids/URLs or tokens.
