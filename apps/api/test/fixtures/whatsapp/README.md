# WhatsApp webhook fixtures

Sample `messages`-field payloads used by unit and e2e tests.

- `dashboard-test-message.json` is the sample Meta sends from the App Dashboard
  "Test" button (Meta's own fake ids; foreign `phone_number_id` → ignored).
- The other files are **modeled on Meta's docs** with fake ids and numbers
  (`59899000111`, `100000000000001`, `200000000000002`).
- Phase 3 / milestone 5 replaces them with **real captured payloads** (from
  `webhook_events.payload`), anonymized: phone numbers, names, wamids, media ids.
- Never commit real phone numbers, names, message content or tokens.
