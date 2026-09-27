# Changelog

All notable changes to this project are documented here. From v0.11.0 on, this file is
maintained by [release-please](https://github.com/googleapis/release-please) from the
[Conventional Commits](https://www.conventionalcommits.org/) history: one version for the
whole repository (API, panel and images share it). v1.0.0 is reserved for the deployed and
audited public demo.

## Before versioning — phases 1–10 (2026-09-24 → 2026-09-27)

Summary of the work before the first release (details: `CLAUDE.md`, `docs/adr/`).

- **1. Scaffold** — pnpm monorepo (`apps/api`, `apps/admin`, `n8n/workflows`, `docs/adr`),
  docker compose with Postgres (app + n8n databases) and n8n.
- **2. Config, env and logging** — Zod env (fail fast), pino-http with request id, `AppError`
  + error middleware, helmet, CORS, rate limits, `/api/v1/health`, Prisma schema and first
  migrations.
- **3. WhatsApp Cloud API** — signed webhook over the raw body, outbox + pg-boss worker,
  idempotency by message id, media download and storage, outbound messages with the 24 h
  window and opt-in, local WhatsApp simulator, anonymized real fixtures.
- **4. Media normalization** — `Transcriber` interface, Groq Whisper (free plan, ZDR) and a
  fake provider, per-contact quota.
- **5. Extraction and catalog** — `ai/` module (Claude behind a provider interface, spend
  guard, versioned prompts, Zod-validated structured output), document and spreadsheet
  conversion, catalog ingest rules, price history and human review queue.
- **6. n8n multi-agent** — receiver, processor, notifier and error workflows; deterministic
  pre-filter without AI; outbox delivery to n8n with retries; anti-spam digests.
- **7. Coexistence and opt-out** — human takeover state machine, message echoes, reply as a
  person, keyword opt-out / opt-in (no LLM).
- **8. Admin auth** — orders routed to the team, Argon2id passwords, JWT access + rotating
  refresh sessions, CSRF guard, roles, declarative panel API, minimal login.
- **9. Admin panel** — mobile-first Next.js panel (dashboard, reviews, conversations,
  real time over SSE, catalog and price charts, rules, users, digest deep links) and the
  public demo mode ("Probar el sistema") at $0.
- **10. Tests** — coverage ratchet, authorization matrix, real Postgres suites (migrations,
  triggers, workers, startup smoke), n8n contract, resilience, security, property-based
  tests, mutation testing report and a real-model prompt-injection eval.
