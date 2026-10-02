# Changelog

All notable changes to this project are documented here. From v0.11.0 on, this file is
maintained by [release-please](https://github.com/googleapis/release-please) from the
[Conventional Commits](https://www.conventionalcommits.org/) history: one version for the
whole repository (API, panel and images share it). v1.0.0 is reserved for the deployed and
audited public demo.

## [0.12.3](https://github.com/sanchezign/smartops-agent/compare/v0.12.2...v0.12.3) (2026-10-02)


### Bug Fixes

* **ci:** publish job checks out the tag and does not cancel the other app ([4ee6fee](https://github.com/sanchezign/smartops-agent/commit/4ee6fee01481a147d891d05993091933b656449e))

## [0.12.2](https://github.com/sanchezign/smartops-agent/compare/v0.12.1...v0.12.2) (2026-10-02)


### Bug Fixes

* **ci:** call the image version check with bash ([5ca301e](https://github.com/sanchezign/smartops-agent/commit/5ca301e21615d04a8208e857b230c3524a601526))


### Tests

* **admin:** E2E login waits for hydration before filling ([3f6efcb](https://github.com/sanchezign/smartops-agent/commit/3f6efcb7332bcba3268798db8d66584a332d244b))

## [0.12.1](https://github.com/sanchezign/smartops-agent/compare/v0.12.0...v0.12.1) (2026-10-02)


### Bug Fixes

* **ci:** published images declare the release version ([39aac11](https://github.com/sanchezign/smartops-agent/commit/39aac1194de9141d3e882f5f6a85dbd48c61fa89))

## [0.12.0](https://github.com/sanchezign/smartops-agent/compare/v0.11.0...v0.12.0) (2026-10-02)


### Features

* **admin:** English panel routes with permanent redirects; review adjustments (phase 13) ([ba76e07](https://github.com/sanchezign/smartops-agent/commit/ba76e07b5137ba6f4a112213946913b8873a4d58))
* **api:** light demo mode with an in-process orchestrator (phase 12 M2.1) ([c2aa436](https://github.com/sanchezign/smartops-agent/commit/c2aa4366759a459b75a8e18e0ee537c512e1fb5a))
* **demo:** one public demo reset per 10 minutes for everyone; M1 Oracle guide (phase 12) ([8eee297](https://github.com/sanchezign/smartops-agent/commit/8eee2975515dc1ef93f780f73bd9903d78cc4f5e))
* **deploy:** automatic retry to create the demo VM with a least-privilege OCI user (phase 12 M1) ([bc4fc41](https://github.com/sanchezign/smartops-agent/commit/bc4fc410d7ff6972cc9c967b68eea14c7c958631))
* **deploy:** light profile for a 1 GB machine (phase 12 M2.2) ([9db00f5](https://github.com/sanchezign/smartops-agent/commit/9db00f58fb9e3f14bde08d5cae75f652f9178d73))
* **deploy:** micro profile trims unused services and tightens SSH (phase 12 M3 prep) ([68b09ac](https://github.com/sanchezign/smartops-agent/commit/68b09ac34f41ba1f71bb6510675918f3b9cc5a0d))
* **deploy:** public demo bundle, shared-account safety and local deploy harness (phase 12 M0) ([14d4bac](https://github.com/sanchezign/smartops-agent/commit/14d4baced49bb25dd9cd8bd9835de684244db7e9))
* **i18n:** business language for WhatsApp texts; panel writes API texts (phase 13 M3) ([cdabcaf](https://github.com/sanchezign/smartops-agent/commit/cdabcaf17a95fd25d8c12a88f3d1d805dca9c19f))
* **i18n:** every panel text in English and neutral Spanish (phase 13 M2) ([486406a](https://github.com/sanchezign/smartops-agent/commit/486406adf385f8869077863421f1f4c5d1bb6bf3))
* **i18n:** panel in English and Spanish with a per-user language (phase 13 M1) ([e40ae0d](https://github.com/sanchezign/smartops-agent/commit/e40ae0d3f7846c8d25d1ae9a5a0da879117b76b7))


### Bug Fixes

* **deploy:** host-setup waits for the apt lock, moves apt-daily to the small hours, masks packagekit ([8403f26](https://github.com/sanchezign/smartops-agent/commit/8403f26eb676482fa79f3eb7f823b6e0c38032b5))
* **deploy:** launch retry treats network failures as transient; 2-5 min waits (phase 12 M1) ([3bcc0de](https://github.com/sanchezign/smartops-agent/commit/3bcc0de2a63356e982c2c436a6399e8f58c6bef1))


### Documentation

* case study in English and Spanish (phase 13 M8) ([bbc59b6](https://github.com/sanchezign/smartops-agent/commit/bbc59b61dbfb9c6c6316e6efd470a0d871585cff))
* close phase 11 — v0.11.0 released, release timings and lessons ([5e2ebb2](https://github.com/sanchezign/smartops-agent/commit/5e2ebb239d3c8fa72c2d8f707f37c2620168e749))
* close phase 13 — i18n, English docs and portfolio (phase 13 M9) ([7e34f20](https://github.com/sanchezign/smartops-agent/commit/7e34f205289f6bb3db5c4045526e164080cf1eeb))
* deploy on an Oracle E2.1.Micro with a light demo profile (phase 12 M2.0) ([a032c59](https://github.com/sanchezign/smartops-agent/commit/a032c59c6f13ab726153a0ed98aae84778ab3733))
* English documentation, portfolio README and link checker (phase 13 M5) ([4204ad6](https://github.com/sanchezign/smartops-agent/commit/4204ad64d1f92488ad684c3baf788c027a79812f))
* panel guide for the business owner in English and Spanish (phase 13 M7) ([1647cfa](https://github.com/sanchezign/smartops-agent/commit/1647cfa47c4be800c19899f384c65b53ab3e4cd4))
* README screenshots and demo GIF, reproducible media pipeline (phase 13 M6) ([672c180](https://github.com/sanchezign/smartops-agent/commit/672c18061f3dabeca388db23243515d33ddd4bf2))
* use the author's full name in the license ([9a5f359](https://github.com/sanchezign/smartops-agent/commit/9a5f3598c750dd1a4d010738ff22454d77ebbe1c))


### Tests

* **i18n:** E2E in English, Spanish smoke with axe, language switch (phase 13 M4) ([dd18f3e](https://github.com/sanchezign/smartops-agent/commit/dd18f3e39cc79f81ef8cff1deef9b385700971dd))

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
