# ADR-005: Whisper-compatible speech-to-text

Date: 2026-09-24
Status: accepted

## Decision

Transcribe WhatsApp voice notes (audio/ogg) with a Whisper-compatible API behind
a `Transcriber` interface. The concrete provider (e.g. OpenAI or Groq) is chosen
in the phase 4 plan. The transcript is stored on the Message next to the
original media.

## Reason

Suppliers and staff send voice notes; the LLM used for extraction does not accept
audio input, so audio must become text first. A standard Whisper-compatible API
lets us switch providers by configuration.

## Consequences

- Mime type and size are validated before sending; requests have timeouts.
- One more API key and vendor cost per audio minute.
- Transcription failures must not block the message pipeline (message is stored
  and flagged).
