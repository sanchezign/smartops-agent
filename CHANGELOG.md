# Changelog

All notable changes to this project are documented here. From v0.11.0 on, this file is
maintained by [release-please](https://github.com/googleapis/release-please) from the
[Conventional Commits](https://www.conventionalcommits.org/) history: one version for the
whole repository (API, panel and images share it). v1.0.0 is reserved for the deployed and
audited public demo.

## [0.11.0](https://github.com/sanchezign/smartops-agent/compare/v0.1.0...v0.11.0) (2026-09-28)


### Bug Fixes

* **admin:** toast texts meet WCAG AA; axe waits for toast transitions ([433dbd2](https://github.com/sanchezign/smartops-agent/commit/433dbd2c89e972a2e22e69f4a72c31c26300a443))
* **admin:** versioned robots.txt; the image no longer assumes public/ exists ([f507bfa](https://github.com/sanchezign/smartops-agent/commit/f507bfa57add5527d77347b6a2e1f04d5840840e))
* **ci:** E2E web servers stop on Linux (pnpm 12 process groups) ([4f991a5](https://github.com/sanchezign/smartops-agent/commit/4f991a5af0eb2d48615ca96cdeeffd12ac5278c0))
* **ci:** release-please setup that survives the first release (phase 11 M5) ([0d90e6c](https://github.com/sanchezign/smartops-agent/commit/0d90e6c080b9aceea8c8069120609e1ed02560a3))


### CI/CD

* quick workflow, least-privilege tokens, workflow linting and main guard (phase 11 M1) ([6568739](https://github.com/sanchezign/smartops-agent/commit/65687398cf37423a858e37dd84a894afa24bbb11))
* release-please and multi-arch GHCR images on release (phase 11 M5) ([7e5321c](https://github.com/sanchezign/smartops-agent/commit/7e5321cffc53f2082153ce216915e9a05d1665b8))
* secret scanning, dependency audit gate, Renovate and SECURITY.md (phase 11 M3) ([72f88ed](https://github.com/sanchezign/smartops-agent/commit/72f88ed799eca5a7dd39f2fc2d7948366c1c4c6b))
* slow suite — Postgres service, coverage gate, build, E2E by policy, nightly (phase 11 M2) ([083776e](https://github.com/sanchezign/smartops-agent/commit/083776e71a57bcc848bffb2a5a5fde282b61e7ba))


### Build

* Docker images for the API and the panel, validated in CI (phase 11 M4) ([eeb1b26](https://github.com/sanchezign/smartops-agent/commit/eeb1b26b6766584574b5d0c9736c0ef165586730))


### Documentation

* CI/CD guide, ADR-022, PR and issue templates (phase 11 M6) ([141be3b](https://github.com/sanchezign/smartops-agent/commit/141be3b8136d6ec8c47022a322f7a238ab8ca568))
* **ci:** measured GitHub timings, first-run fixes and phase 11 status ([1942ab6](https://github.com/sanchezign/smartops-agent/commit/1942ab6c621a75bee4518dd53b05958a23da9769))
* **ci:** release recovery and rebase-merge notes (phase 11 M6) ([676f365](https://github.com/sanchezign/smartops-agent/commit/676f3652317fed9deb8df5595cb547a974cecc1d))
* **ci:** Release-As must go in a commit that changes files ([58ffdc9](https://github.com/sanchezign/smartops-agent/commit/58ffdc93b030fab788a70a5d16ddc6666dbf0262))


### Tests

* **api:** smaller ZIP bomb that still proves the real-size cap ([3b638f3](https://github.com/sanchezign/smartops-agent/commit/3b638f33dc695a8549c1dcb6733bc426bf6ffe35))

## [Before v0.11.0] — phases 1–10 (2026-09-24 → 2026-09-27)

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
