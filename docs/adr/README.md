# Architecture decision records

One record per significant decision: context, decision, consequences. ADR-023 (the $0 deploy on
one Oracle Cloud E2.1.Micro) supersedes ADR-007.

- [ADR-001](ADR-001-pnpm-monorepo.md) — pnpm workspaces monorepo
- [ADR-002](ADR-002-n8n-orchestration.md) — n8n for multi-agent orchestration
- [ADR-003](ADR-003-pg-boss-queue.md) — pg-boss for async jobs
- [ADR-004](ADR-004-claude-api.md) — Claude API for classification and extraction
- [ADR-005](ADR-005-whisper-transcription.md) — Whisper-compatible speech-to-text
- [ADR-006](ADR-006-no-oauth.md) — No OAuth, JWT only
- [ADR-007](ADR-007-deploy-render.md) — Deploy everything on Render
- [ADR-008](ADR-008-media-storage.md) — Media stored in Postgres (bytea) behind `MediaStorage`
- [ADR-009](ADR-009-whatsapp-opt-in.md) — Opt-in required for business-initiated WhatsApp messages
- [ADR-010](ADR-010-transcription-provider.md) — Groq whisper-large-v3 (free plan) for speech-to-text
- [ADR-011](ADR-011-llm-provider-models-budget.md) — LLM provider, Claude models, spend guard and prompt-injection policy
- [ADR-012](ADR-012-human-review.md) — Catalog ingest rules and human review items
- [ADR-013](ADR-013-document-conversion.md) — Document conversion (xlsx/xls/csv/txt/docx) with isolation and limits
- [ADR-014](ADR-014-spreadsheet-formats.md) — Spreadsheets read deterministically with remembered formats per supplier
- [ADR-015](ADR-015-n8n-contract-outbox-notifications.md) — n8n contract: reliable outbox, AI-free pre-filter and anti-spam notifications
- [ADR-016](ADR-016-human-takeover.md) — Human takeover pauses only automatic replies to the contact
- [ADR-017](ADR-017-opt-out.md) — Deterministic opt-out, gated at the outbound service
- [ADR-018](ADR-018-panel-auth.md) — Panel auth: rotating refresh sessions, Argon2id, same-origin deploy
- [ADR-019](ADR-019-panel-media-auth.md) — Chat media fetched with the Bearer, shown from blob: URLs
- [ADR-020](ADR-020-panel-real-time.md) — Panel real time: DB triggers → one LISTEN per API process → SSE
- [ADR-021](ADR-021-public-demo-mode.md) — Public demo: DEMO_MODE with the real pipeline, fakes and no Meta
- [ADR-022](ADR-022-ci-cd.md) — CI/CD on GitHub Actions for a private repo on GitHub Free
- [ADR-023](ADR-023-deploy-oracle-micro.md) — $0 public demo on one Oracle Always Free E2.1.Micro
- [ADR-024](ADR-024-panel-i18n.md) — Panel in English and Spanish with next-intl; WhatsApp texts in the business language
- [ADR-025](ADR-025-light-demo-profile.md) — Light demo profile: in-process orchestrator, API + worker in one process
- [ADR-026](ADR-026-append-only-backups.md) — Append-only encrypted backups to Object Storage, uploaded by a pinned OCI CLI container
- [ADR-027](ADR-027-keepalive-load.md) — A nightly keep-alive CPU load so the demo VM does not look idle to Oracle
- [ADR-028](ADR-028-security-alert-policy.md) — Security alerts: pull requests block what they introduce, a nightly scan owns what exists
- [ADR-029](ADR-029-panel-visual-identity.md) — Panel visual identity "Señal": graphite, one safety yellow for what needs a person
- [ADR-030](ADR-030-demo-operator-resolves-column-mapping.md) — In DEMO_MODE the public operator can resolve the column-mapping review
