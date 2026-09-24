# ADR-004: Claude API (Anthropic SDK) for classification and extraction

Date: 2026-09-24
Status: accepted

## Decision

Use the Anthropic SDK behind an `LlmProvider` interface in `apps/api/src/ai/`.
Classifier model `claude-haiku-4-5` (fast/cheap) and extractor model
`claude-sonnet-5` (PDF + image input, structured output), both configured via
env vars. Prompts are versioned files in `apps/api/src/ai/prompts/*.md`. Outputs
are validated with Zod before persisting; timeouts, fallback, latency and token
usage logging are mandatory.

## Reason

The core value is turning chaotic supplier documents (PDFs, photos, free text)
into structured catalog data; Claude handles document and image input natively.
The provider interface keeps the rest of the code independent of the vendor.

## Consequences

- Model ids and PDF/image input format must be verified in the official docs in
  phase 5 before implementing.
- No feature imports the SDK directly.
- Per-contact usage limits are needed to cap cost.
- Claude does not take audio: voice notes go through ADR-005 first.
