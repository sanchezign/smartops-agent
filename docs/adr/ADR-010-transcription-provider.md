# ADR-010: Groq whisper-large-v3 (free plan) as the speech-to-text provider

Date: 2026-09-24
Status: accepted

## Decision

Implements ADR-005 (Whisper-compatible speech-to-text). Voice notes are transcribed
with **Groq** `whisper-large-v3` on the **free plan**, through a generic
OpenAI-compatible client (`POST {baseUrl}/audio/transcriptions`, multipart) behind the
`Transcriber` interface (`apps/api/src/modules/transcription/`).

- Configuration only: `TRANSCRIPTION_PROVIDER` (groq | openai | fake),
  `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`,
  `TRANSCRIPTION_LANGUAGE` (es). Switching to OpenAI or another compatible provider
  needs no code change.
- A `fake` provider (default in development) returns deterministic transcripts
  registered by the WhatsApp simulator, so the whole flow runs without a key. It is
  rejected in production by env validation.
- Language hint `es` + a versioned vocabulary prompt
  (`transcription/prompts/vocabulary.md`, ≤ 224 tokens).

## Reason

- **OGG support:** WhatsApp voice notes are `audio/ogg` (opus). Groq accepts ogg as-is;
  OpenAI's current docs do not list ogg, which would require transcoding (ffmpeg) in
  the image.
- **Cost constraint ($0):** the free plan covers a portfolio demo (20 req/min,
  2,000 req/day, 7,200 audio s/hour, 28,800 audio s/day, 25 MB files). Paid pricing is
  also low ($0.111/audio hour, 10 s minimum billed).
- **Accuracy:** whisper-large-v3 has a lower WER than the turbo variant (10.3% vs 12%);
  Spanish price lists need accurate numbers.
- **Data:** Groq does not train on customer data by contract and offers Zero Data
  Retention (ZDR). Correction (2026-09-24, from the Groq console and
  console.groq.com/docs/your-data): since 2025-10-15 Groq MAY retain inference inputs and
  outputs — including `/openai/v1/audio/transcriptions` — for up to 30 days for system
  reliability and abuse monitoring, unless ZDR is enabled ("Inference APIs ZDR" or
  "Global ZDR" in Settings → Data Controls). With ZDR enabled nothing is retained.

## Consequences

- **REQUIREMENT:** every Groq account used by this project — development, demo and any
  real client — must have ZDR enabled (Settings → Data Controls → Global ZDR, or at
  least Inference APIs ZDR) before sending audio. Voice notes are personal data. This
  is part of the deploy checklist.
- AAC and AMR audio (also possible on WhatsApp) are not accepted by Groq or OpenAI
  without transcoding: they are skipped (`unsupported_format`) until an ffmpeg step is
  added (Known issues).
- Free-plan limits return 429 + `retry-after`; jobs retry with backoff, and a daily
  per-contact limit protects the quota.
- One more API key (user-provided, never committed) and one more external vendor
  receiving personal data.
- Transcripts are text only; the original audio stays in `media_blobs` (ADR-008).
