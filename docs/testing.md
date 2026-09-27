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

| Path                                    | Covered by                                                         | Gap closed in                                |
| --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Webhook signature                       | unit + HTTP e2e (invalid → 401)                                    | M7 (properties) — done                       |
| Idempotency (webhook body, waMessageId) | integration                                                        | M3 (two workers at once) — done              |
| Outbox + retries + DLQ                  | outbox integration                                                 | M3 + M5 — done                               |
| Price parsing                           | examples                                                           | M7 (properties) — done                       |
| Opt-out / opt-in                        | unit + integration                                                 | M7 (accents / case) — done                   |
| Bot / human modes                       | state machine + integration                                        | —                                            |
| Digests                                 | unit + integration                                                 | M7 (`neutralize`) — done                     |
| Auth / sessions                         | unit + integration (rotation, reuse, CSRF, tampered JWT, alg none) | M6 — done                                    |
| Authorization                           | route inventory (401 / 403 admin-only)                             | M2 (full matrix) — done                      |
| Demo mode safety                        | unit (no Meta at any layer)                                        | —                                            |
| n8n contract                            | static tests on the exported workflows                             | M4 (generated contract) — done               |
| Resilience                              | outbox retries, fake Graph faults                                  | M5 — done                                    |
| Startup / shutdown                      | —                                                                  | M3 (smoke of server.ts and worker.ts) — done |

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

## Real Postgres (M3)

- Scratch databases (`test/integration/scratch-db.ts`): derived from TEST_DATABASE_URL (which must
  end in `_test`) as `<test>_shadow_test` and `<test>_demo`; every CREATE and DROP goes through the
  same name guard, so `smartops` and `smartops_demo` can never be touched. Both are dropped in
  `afterAll` (and a leftover of an interrupted run is dropped before re-creating it).
- `migrations.test.ts`: all migrations from zero, drift check (`prisma migrate diff
--from-config-datasource --to-schema prisma/schema.prisma --exit-code`), and the exact list of
  hand-written CHECKs, triggers, partial unique indexes and STORAGE EXTERNAL. Adding one of those
  means adding it to the list.
- `demo-seed.test.ts`, `realtime-events.test.ts` (every trigger + LISTEN reconnect after
  `pg_terminate_backend`), `job-workers.test.ts` (real pg-boss: retry → DLQ handlers, crons, queue
  options), `startup-smoke.test.ts` (real `server.ts` / `worker.ts`, SIGTERM → exit 0; on Windows
  the signal travels through `support/signal-bridge.mjs` because Windows has no POSIX signals).
- `server.ts` / `worker.ts` stay at 0 % in the coverage report: they run as child processes in the
  smoke test, which V8 coverage of the test process does not see.

## n8n contract (M4)

- `n8n/contract.json` is GENERATED (`pnpm --filter @smartops/api n8n:contract`) from
  `INTERNAL_ROUTE_SCHEMAS` (the table the internal router validates with) and
  `messageReadyPayloadSchema` (Zod → JSON Schema with `z.toJSONSchema`). Never edit it by hand:
  `test/unit/n8n-contract.test.ts` fails when it is stale.
- The same test checks the table equals the routes mounted under `/api/v1/internal`, and
  dry-runs the EXPORTED workflows (`test/helpers/n8n-contract-check.ts`): trigger inputs → Set
  nodes → HTTP nodes evaluated with their real expressions → method + path must be a contract
  route, credential "SmartOps API", body accepted by the API's Zod schema. Negative cases prove
  it catches a renamed field, a wrong path or method, another credential, an unknown kind, a
  reference to a missing node.
- `test/integration/n8n-contract.test.ts` also validates every REAL `message.ready` payload the
  outbox sends against the contract schema.

## Resilience (M5)

- `test/integration/db-outage.test.ts`: a TCP proxy INSIDE the test sits between the API-side
  connections and Postgres (the container is never stopped). Cut → `/health` 503, the LISTEN
  connection drops, pg-boss logs errors and keeps polling; restore → `/health` 200, the listener
  reconnects and resyncs, the job queued during the outage runs, new events arrive.
- `test/unit/resilience-http.test.ts`: real local HTTP peers that never answer, answer late,
  stall a download mid-body, rate-limit (429 + retry-after) or fail (5xx) — n8n client, Graph
  media client, Graph send client, Anthropic provider. Every case ends in a typed error inside
  its timeout; transient ones are retryable (pg-boss retries), permanent ones stay permanent.
  **Retry-After is not honoured**: the queue backoff applies (documented choice, not a bug).
- LLM timeout end to end (`ingestion.test.ts`): ledger row `error / timeout` at $0, 503 so n8n
  retries (then its error workflow raises an alert), the run never stays in `extracting`.

## Security (M6)

- `security-tokens.test.ts`: access-token forgery matrix signed with the RIGHT key (issuer,
  audience, HS512, missing sub / sid, unknown role, nbf, expiry, malformed input) → all rejected.
- `security-limits.test.ts`: every limiter (global, webhook, internal, demo inject / reset)
  answers 429 in the error shape; budgets are independent (a panel flood never blocks Meta's
  webhook nor n8n; the internal limiter runs BEFORE the key check). Login limiter, SSE caps and
  lockout doubling (capped at 1 h) were already covered.
- Logs (user addendum C): `log-safety.test.ts` drives the API through every door a secret
  comes in by (passwords, Bearer, refresh cookie, internal key, Meta signature and verify
  token, broken / oversized bodies, 429, a crashing handler) and
  `log-safety-worker.test.ts` processes every WhatsApp fixture — both with the PRODUCTION logger
  factory at `trace` (`test/helpers/log-capture.ts`). No secret, full phone, BSUID, message text
  or media URL may appear. Verified to fail when the verify-token URL redaction is removed.
- `prompt-injection.test.ts`: our own set (OWASP LLM Top 10 as a guide, no copied corpus) against
  the deterministic layers — input framing, keyword detector, output validation / rules, digest
  neutralization.
- Known gaps pinned with `it.fails` (green while the gap exists, red once fixed): JWT without
  `exp` accepted; `< /tag>` and full-width brackets not neutralized; keyword detector misses
  zero-width characters and synonyms. Reported in CLAUDE.md "Known issues".

## Properties (M7)

fast-check 4.10.2 (pinned in both apps). `apps/api/test/unit/properties.test.ts` (19) and
`apps/admin/test/properties.test.ts` (5): spreadsheet prices (es-UY / en text, numeric cells,
never a wrong-looking result, "12.50" in a decimal-comma table never read as decimals),
`applyPercentage` (direction, ≤ 4 decimals, within 0.1 pp for prices ≥ 1), supplier names
(idempotent, case / accents / punctuation), outbound statuses (never backwards, read and failed
final, order-independent without failures), the 24 h window, business hours (next opening is
open, later, nothing opens in between — 4 time zones incl. DST), `neutralize`, the webhook
signature (any body; any flipped bit / other secret rejected), opt-out keywords (case, accents,
filler), panel number round trips (pre-filled price, displayed price, rules numbers, percentages).
Default 300 runs per property (fast suite); `FC_RUNS=5000` for a deeper local pass (done: no
counterexample). A failure prints the seed and the shrunk input.

## CI readiness (M8) — the GitHub Actions YAML itself is phase 11

Proposed jobs (Linux runners; times measured on the dev PC, CI estimated ×2 + install):

| Job                    | Runs                     | Command                                                                                                                                        | Local            | CI estimate |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------- |
| fast                   | every PR / push          | `pnpm lint && pnpm typecheck && pnpm test:fast && pnpm build`                                                                                  | ~1 min           | 4–5 min     |
| integration + coverage | every PR                 | Postgres service (`postgres:17-alpine`, db `smartops_test`) → `pnpm test:coverage` (API unit + integration + panel, ratchet thresholds = gate) | ~3 min           | 6–7 min     |
| e2e                    | per `E2E_POLICY` (below) | `pnpm exec playwright install --with-deps chromium webkit` → `pnpm test:e2e`                                                                   | ~3.5 min + build | 12–15 min   |

- Env in CI: `TEST_DATABASE_URL` (integration) and `E2E_BASE_DATABASE_URL` (the E2E derives
  `<db>_e2e_demo` from it). **No secret is needed**: the API test env and the E2E are
  self-contained with fake values (DEMO_MODE forces fakes and blocks Meta). The Anthropic key never
  goes to GitHub; the real-LLM evaluation is a manual script (M10).
- **One variable switches the E2E policy** — repository variable `E2E_POLICY`, read by
  `apps/api/scripts/ci/e2e-policy.ts` (unit-tested):
  - `private` (default): PRs to `main`, manual runs, and a nightly run only when `main` got new
    commits in the last 24 h;
  - `public`: every PR (Actions is free for public repos on standard runners), manual, nightly with
    the same new-commits rule.
- Budget while private (GitHub Free: 2,000 Linux minutes / month): e.g. 30 PR updates × ~11 min
  (fast + integration) ≈ 330, 8 PRs to main × ~15 min E2E ≈ 120, 20 nightly runs × ~15 min ≈ 300 →
  **≈ 750 min / month**, well inside the quota. Verify the rounding / current quota in phase 11.
- Coverage gate: CI runs `pnpm test:coverage`; thresholds come from `coverage-thresholds.json`
  (ratchet). Raising them is a local step (`pnpm --filter <app> coverage:ratchet`) committed with
  the change; the guard test forbids lowering them.
- Flaky control: CI retries a failed E2E test once and reports it as **flaky** (list summary +
  GitHub annotation via the `github` reporter) — never silently green. Locally: no retries.
- Flaky check done (2026-09-27): `pnpm test:e2e -- --repeat-each=3` (333 runs, 13 min). Every
  read-only test passed 3/3 in the three browsers. Failures were NOT flakiness:
  - tests that consume seed data (approve / reject with the bottom buttons, create a user) cannot
    repeat on the same database — their first run passed; `--repeat-each` is only meaningful for
    read-only specs (CI runs each test once on a fresh seed);
  - the mobile chat-photo test failed its axe check on every repeat because the repeated desktop
    replies left a failed/canceled human bubble in that chat: **real accessibility bug** (see
    CLAUDE.md Known issues), deterministic once the data exists; the spec passes on a fresh seed.
- The E2E is self-contained for CI: `E2E_BASE_DATABASE_URL` instead of `apps/api/.env`, and fake
  values for every required secret in `playwright.config.ts` (real provider keys are blanked, so
  a developer's keys never reach the E2E API either).

## Mutation testing (M9) — report only, no gate

- Stryker 10.0.0 (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, pinned exactly):
  `pnpm --filter @smartops/api mutation`. Config `apps/api/stryker.config.json`, runner config
  `apps/api/vitest.stryker.config.ts` (unit tests only, no database). Reports in
  `apps/api/reports/mutation/` (gitignored). Mutated: price-math, sheet-values, session-rules,
  login-lockout, optout-detector, message-status, digest-rules.
- A SURVIVED mutant = a change to the code that no test notices. The report is used to add the
  missing assertions; there is no threshold that fails a build (user decision).

## Real-model evaluation (M10) — manual, never in CI

- `pnpm --filter @smartops/api ai:eval --dry-run` (FREE: `count_tokens`) prints the exact input
  tokens and the expected / worst-case cost of our own injection set (8 cases: 2 controls,
  direct and indirect injection, excessive agency, prompt leakage, output handling).
- `--confirm-spend` runs it through the production AiClient (budget caps + ai_usages ledger) and
  prints PASS / FAIL per case. Only with the user's explicit OK; the script refuses to run when
  `CI` is set, and the Anthropic key never goes to GitHub.
