# Testing (phase 10)

## Suites

| Suite           | Command                                        | What                                                                                         | Time (dev PC) |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| API fast        | `pnpm --filter @smartops/api test:unit`        | unit + HTTP e2e with stubbed deps (no DB)                                                    | ~7 s          |
| API integration | `pnpm --filter @smartops/api test:integration` | real Postgres (`TEST_DATABASE_URL`, name must end in `_test`), pg-boss, triggers             | ~75 s         |
| Panel           | `pnpm --filter @smartops/admin test`           | pure logic of the panel                                                                      | < 1 s         |
| Browser E2E     | `pnpm test:e2e`                                | Chromium desktop, Pixel 7, iPhone 15 (WebKit); API in DEMO_MODE + real worker + n8n stand-in | ~3.5 min      |
| Coverage        | `pnpm test:coverage`                           | both apps, with the ratchet thresholds as a gate                                             | ~80 s         |

Root shortcuts: `pnpm test:fast` (API unit + panel), `pnpm test:integration`, `pnpm test:e2e`.

## Coverage ratchet

- Thresholds live in `apps/api/coverage-thresholds.json` and `apps/admin/coverage-thresholds.json`.
  Each one is the measured value minus 2 points, rounded down.
- `pnpm --filter <app> coverage:ratchet` (after `test:coverage`) raises them when the measurement
  allows it and never lowers them.
- `test/unit/coverage-thresholds.test.ts` fails if any threshold is lower than in HEAD or in
  `origin/main`, or if a key was removed.
- Targets (not blocking yet): API 80 % lines globally; critical pure modules 95 % lines and
  90 % branches; panel logic 90 %.
- The panel is measured on its LOGIC only (`src/lib`, the pure `features/*.ts`). Components are
  covered by the browser E2E; React Testing Library is not used (decision of phase 10).

## Baseline (2026-09-27, before phase 10)

API (1,087 tests): **84.1 % lines, 77.8 % branches, 84.2 % functions, 82.1 % statements.**

| Module                | Lines | Branches | Note                                                              |
| --------------------- | ----- | -------- | ----------------------------------------------------------------- |
| jobs                  | 31.4  | 16.2     | **gap**: worker registration, retry/backoff configs, DLQ handlers |
| modules/demo          | 35.5  | 40.6     | seed and reset only run in E2E (not measured by Vitest)           |
| server.ts / worker.ts | 0     | 0        | **gap**: startup / shutdown not tested                            |
| modules/admin         | 72.7  | 73.2     | routes of phase 9 mostly tested through the E2E                   |
| modules/reviews       | 89.9  | 69.0     | approve paths through integration only                            |
| modules/internal      | 100   | 50.0     |                                                                   |
| modules/events        | 97.3  | 75.9     |                                                                   |
| modules/documents     | 90.2  | 74.8     | worker thread entry not measured                                  |
| all other modules     | ≥ 89  | 75–95    |                                                                   |

Critical pure modules: 100 % lines except `media-policy` 95.3, `digest-rules` 94.2, `tokens` 93.3,
`business-hours` 97.1. Branches below 90: `event-hub` 77.8, `media-policy` 81.8,
`digest-rules` 83.1, `message-status` 83.3, `sheet-values` 87.0, `tokens` 87.5.

Panel logic (68 tests): **78.8 % lines, 69.5 % branches.** Gaps: `lib/format.ts` 48 % lines,
`features/reviews/labels.ts` and `permissions.ts` 0 %, `features/conversations/labels.ts` 67 %,
`features/realtime/invalidation.ts` 69 %.

## Critical paths (status before phase 10)

| Path                                    | Covered by                                                         | Gap closed in                                   |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Webhook signature                       | unit + HTTP e2e (invalid → 401)                                    | M7 (properties)                                 |
| Idempotency (webhook body, waMessageId) | integration                                                        | M3 (two workers at once)                        |
| Outbox + retries + DLQ                  | outbox integration                                                 | M3 (queue configs, DLQ handlers), M5 (n8n down) |
| Price parsing                           | examples                                                           | M7 (properties)                                 |
| Opt-out / opt-in                        | unit + integration                                                 | M7 (accents / case)                             |
| Bot / human modes                       | state machine + integration                                        | —                                               |
| Digests                                 | unit + integration                                                 | M7 (`neutralize`)                               |
| Auth / sessions                         | unit + integration (rotation, reuse, CSRF, tampered JWT, alg none) | M6                                              |
| Authorization                           | route inventory (401 / 403 admin-only)                             | M2 (full matrix) — done                         |
| Demo mode safety                        | unit (no Meta at any layer)                                        | —                                               |
| n8n contract                            | static tests on the exported workflows                             | M4 (generated contract)                         |
| Resilience                              | outbox retries, fake Graph faults                                  | M5                                              |
| Startup / shutdown                      | —                                                                  | M3 (smoke of server.ts and worker.ts)           |

## Authorization matrix (M2)

- `test/e2e/authz-matrix.test.ts` lists the routes the app REALLY serves (`listRoutes(app)`, fed
  by every `mount()` in `app.ts`, DEMO_MODE routers included: 61 routes) and calls each one as
  anonymous, operator and admin → 401 / 403 / allow. The result must equal
  `test/fixtures/authz-matrix.json`: a new route without an entry fails, a changed permission fails.
- Invariants no fixture can override: anonymous reaches only `GET /health` and `GET /demo/info`;
  the internal API, the webhook and the demo Graph API never open with a panel token; every
  `/admin/*` route answers 401 without a login; the declarative admin table's roles hold.
- Regenerate only on purpose: `AUTHZ_RECORD=1 pnpm --filter @smartops/api exec vitest run test/e2e/authz-matrix.test.ts`,
  then review the diff.
- `test/unit/review-permissions-sync.test.ts`: the panel's copy of the review rule
  (`canResolve`) equals the API's `canResolveReview` for every role × scope × kind.
