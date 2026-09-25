# Extraction test data (phase 5)

Fictitious price lists sent by the user over WhatsApp on 2026-09-25 (phase 3 M5), exported
byte-for-byte from `media_blobs` (the bytes the API downloaded from Meta).

| File                     | What it is                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `lista-prueba.pdf`       | 1-page fictitious September price list (PDF, identical to the original)                                                        |
| `lista-precios-foto.jpg` | photo of a handwritten fictitious October price list, as delivered by WhatsApp (original PNG recompressed to JPEG by WhatsApp) |

The matching webhook payloads are `../whatsapp/message-document.json` and
`../whatsapp/message-image.json`.
