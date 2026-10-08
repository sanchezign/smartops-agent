# Extraction test data (phase 5)

Fictitious price lists sent by the user over WhatsApp on 2026-09-25 (phase 3 M5), exported
byte-for-byte from `media_blobs` (the bytes the API downloaded from Meta).

| File                     | What it is                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `lista-prueba.pdf`       | 1-page fictitious September price list (PDF, identical to the original)                                                        |
| `lista-precios-foto.jpg` | photo of a handwritten fictitious October price list, as delivered by WhatsApp (original PNG recompressed to JPEG by WhatsApp) |

The matching webhook payloads are `../whatsapp/message-document.json` and
`../whatsapp/message-image.json`.

## Other files

| File / dir                             | What it is                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-transcript.txt`                 | real Groq transcript of a voice note, with its ASR error ("de lunas")                                                                                                                                                                  |
| `injection-message.txt`                | malicious supplier text (prompt injection) for the security tests                                                                                                                                                                      |
| `expected.json`                        | ground truth: product names per fixture (prompts must never quote them, `test/unit/prompts.test.ts`) and the October photo vs September catalog outcome (M4 e2e)                                                                       |
| `golden/{classify,extract}/<key>.json` | real Claude outputs recorded by `pnpm --filter @smartops/api ai:record-golden --confirm-spend` (key = sha256 of the message content); served by the fake LLM provider in dev/CI/demo and checked by `test/unit/golden-outputs.test.ts` |

Re-record the goldens only after a prompt/schema change, with a fresh `--dry-run` and the
user's OK on the estimated cost.

## English set (phase 14 M5c, `en/`)

The twin of everything above for the English demo content (ADR-031): fictitious Demo Distributing
Inc. lists in US dollars and US units. All of it is generated or synthetic (no real company):

| File                                 | What it is                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `en/price-list-september.pdf`        | 1-page September list, written by `scripts/fixtures/build-english-pdf.mjs` (deterministic bytes)         |
| `en/price-list-october-photo.jpg`    | the October price list "photographed" on a desk (SVG rendered with sharp)                                |
| `en/voice-transcript.txt`            | Groq `whisper-large-v3` transcript of a synthetic voice note (Echogarden, local eSpeak voice)            |
| `en/injection-message.txt`           | English prompt-injection text; it must end in `needs_review`, like the Spanish one                       |
| `en/expected.json`                   | ground truth for the English fixtures (read by `test/unit/prompts.test.ts`, merged with `expected.json`) |
| `../sheets/en/prices-multiple*.xlsx` | English spreadsheets, built by `scripts/fixtures/build-sheet-fixtures.ts`                                |

Its recorded outputs are made with `ai:record-golden --lang en` (M5d).
