# CI/CD (phase 11)

Design decisions: [ADR-022](adr/ADR-022-ci-cd.md). Test suites and what they cover:
[testing.md](testing.md).

The repository is **private on GitHub Free** while the demo is built. That shapes the design:
no branch protection / rulesets, no CodeQL, no GitHub secret scanning or push protection, no
dependency-review action and no artifact attestations API on private repos. Each gap has a
free replacement below. Going public is NOT automatic: it comes after a separate full security
audit (user decision, 2026-09-27).

## Workflows

| Workflow | File                             | Triggers                                                          | Jobs                                                                   |
| -------- | -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CI       | `.github/workflows/ci.yml`       | push (any branch), PR to `main`, nightly 03:00 Montevideo, manual | `quick`, `plan`, `integration-coverage`, `e2e`, `images`, `main-guard` |
| Release  | `.github/workflows/release.yml`  | push to `main`, manual                                            | `release-please`, `build` (4× native), `merge` (2×)                    |
| Security | `.github/workflows/security.yml` | Mondays 03:00 Montevideo, manual                                  | full-history gitleaks + production audit gate                          |

### CI jobs

- **quick** — every push to any branch (and pull requests from forks). Its check is attached to
  the commit, so it also shows on the pull request without running twice:
  actionlint + zizmor on the workflows, gitleaks on the NEW commits, `pnpm install
--frozen-lockfile`, the dependency audit gate, `format:check`, `lint`, `typecheck`,
  `test:fast` (API unit + e2e with Supertest, panel logic).
- **plan** — pull requests, nightly and manual runs. Decides:
  - `code`: false for docs-only changes (then the slow jobs skip);
  - `docker`: Dockerfiles, `.dockerignore`, any `package.json`, the lockfile, Prisma,
    `apps/admin/next.config.ts` or `scripts/ci/` changed (always on manual runs, never nightly);
  - `e2e`: `apps/api/scripts/ci/e2e-policy.ts` with the repository variable `E2E_POLICY`.
- **integration-coverage** — Postgres 17 service container → `pnpm test:coverage` (API unit +
  integration against the real DB + panel; the coverage ratchet thresholds are the gate) →
  `pnpm build`.
- **e2e** — Postgres service → Playwright (desktop Chromium, Pixel 7, iPhone/WebKit, axe
  checks) against a production build of the panel and the API in DEMO_MODE. Browsers are
  installed on every run (no cache — user decision). Report uploaded on failure (7 days).
- **images** — builds the API and panel images (amd64, never pushed), checks that no image
  contains `.env` files, keys or secrets (`scripts/ci/image-secrets-check.sh`), runs both
  container smoke tests (`scripts/ci/{api,admin}-container-smoke.sh`: migrations, health,
  SIGTERM → exit 0, fake values only) and Trivy (fixable HIGH/CRITICAL OS packages block).
- **main-guard** — push to `main`: fails if the commit does not belong to a merged pull
  request (soft enforcement while branch protection is unavailable). Together with the local
  pre-push hook (`pnpm hooks:install` once per clone; `ALLOW_PUSH_TO_MAIN=1` overrides it).

### E2E policy (one variable)

| `E2E_POLICY`        | Pull requests      | Nightly                        | Manual |
| ------------------- | ------------------ | ------------------------------ | ------ |
| `private` (default) | only PRs to `main` | only if `main` changed in 24 h | always |
| `public`            | every PR           | only if `main` changed in 24 h | always |

Switch it in Settings → Secrets and variables → Actions → Variables. Unset = `private`.

## Running the slow suite by hand

GitHub only shows **Run workflow** for workflows that exist on the **default branch**. Until
`ci.yml` is on `main` (phase 11 close), the way to run the slow suite is a pull request:

1. On GitHub: **Pull requests → New pull request**, base `main`, compare
   `feat/phase-11-ci-cd` → **Create draft pull request**.
2. The `pull_request` run starts by itself: `plan` → `integration-coverage` + `e2e` +
   `images` (the Dockerfiles are new against `main`). `quick` already ran on the push.
3. Follow it in **Actions → CI** (the run named after the PR). The same draft PR is reused to
   close the phase.

Once `ci.yml` is on `main`: **Actions → CI → Run workflow → branch** → Run. A manual run
executes `quick`, `plan`, `integration-coverage`, `e2e` and `images` on that branch.

## Timings and minutes budget

GitHub Free, private: 2,000 Linux minutes / month; every job is rounded UP to the minute;
arm64 standard runners (`ubuntu-24.04-arm`) also consume the included minutes. Measured so
far on GitHub: `quick` 1 m 53 s. The slow jobs are **pending the first real run** (local
reference on the dev PC: coverage 163 s, build 25 s, E2E 203 s + browser install; CI is
expected 2–3× slower) — update this table after it.

| Job                  | Runs                              | GitHub (measured)     |
| -------------------- | --------------------------------- | --------------------- |
| quick                | every push                        | ~2 min                |
| integration-coverage | PR to main, manual, nightly*      | pending the first run |
| e2e                  | per `E2E_POLICY`                  | pending the first run |
| images               | PR/manual when Docker inputs move | pending the first run |
| release (4 builds)   | once per release                  | pending the first run |

\* Nightly only when `main` got commits in the last 24 h.

Rough monthly estimate while private (to be re-checked with the real timings): 60 pushes ×
2 min + 8 PRs to `main` × ~30 min + ~15 nightly runs × ~25 min + 2 releases × ~40 min ≈
**1,000 min / month**, half the quota. Set the Actions budget to **$0** so an overrun stops
instead of billing (see the settings checklist).

## Releases

- One version for the whole repository (root, API, panel and both images). Tags `vX.Y.Z`.
  v1.0.0 is reserved for the deployed and audited public demo.
- release-please keeps a **release PR** (`chore(main): release X.Y.Z`) up to date on every
  push to `main`, with the changelog built from Conventional Commits. Merging it (rebase-merge,
  only when the maintainer says so) creates the tag and the GitHub release, and the **same run**
  builds the images: a tag created with `GITHUB_TOKEN` never triggers another workflow.
- The first release is forced to **0.11.0** by the empty commit `chore: release 0.11.0` with
  the body `Release-As: 0.11.0` (one-shot; a `release-as` in the config would propose the same
  version forever — a guard test forbids it). To force another version later, repeat that
  pattern.
- Release PRs opened by `GITHUB_TOKEN` trigger **no CI checks** (GitHub rule). That is expected:
  the diff is only versions and the changelog. If checks are wanted, run CI by hand on the
  `release-please--branches--main` branch.
- Images: `ghcr.io/sanchezign/smartops-api` and `ghcr.io/sanchezign/smartops-admin`, tags
  `X.Y.Z`, `X.Y` and `sha-xxxxxxx` (no `latest`: deploys pin a version). Built natively on
  amd64 and arm64 runners (the Oracle VM of phase 12 is ARM), every architecture checked
  BEFORE the push (secrets check, container smoke test, Trivy), pushed by digest with SBOM and
  provenance, merged into one multi-arch tag. **Private while the repository is private**
  (re-decided in phase 12). Nothing is deployed by CI yet (phase 12).
- API image: one image, three commands — `node dist/server.js` (default), `node
dist/worker.js`, `node node_modules/prisma/build/index.js migrate deploy` (release step).
  Configuration only through environment variables. Panel image: Next.js `standalone`
  (`NEXT_OUTPUT=standalone`, only in the Dockerfile — Windows cannot build it without symlink
  rights), `NEXT_PUBLIC_API_BASE` is a build argument (default `/api/v1`, same origin).

## Supply chain

- Actions pinned to full commit SHAs (version in a comment); tool images pinned as
  `image:tag@sha256:…`; Renovate updates both (custom regex manager for the image pins).
- Renovate (Mend app, free): weekly, Mondays before 06:00 Montevideo, minimum release age 3
  days (1 day for security fixes), non-major updates grouped, majors disabled for Prisma,
  ESLint, Next, React and the Node/Postgres images (planned upgrades only). Dependabot cannot
  update pnpm 12 lockfiles, so it is used for **alerts only**.
- `pnpm audit --prod` gate (`apps/api/scripts/security/audit-gate.ts`): HIGH/CRITICAL block
  unless listed in `security/audit-exceptions.json` with a justification and an expiry date.
  **The four current exceptions expire on 2026-10-31**: from that day `quick` fails until the
  dependency is updated or the exception is renewed with a new justification.
- gitleaks: new commits on every push, the whole history weekly; `.gitleaks.toml` allowlists
  exact file + value pairs only (three fake test constants).
- Workflows: `permissions: {}` at the top, the minimum per job, `persist-credentials: false`,
  no `${{ }}` inside `run:` scripts (values go through `env:`), no Actions cache in the release
  workflow (cache poisoning), checked by actionlint and zizmor.

## GitHub settings checklist (the maintainer applies them; CI never changes repo settings)

Names follow the GitHub UI in September 2026 and may move slightly.

1. **Settings → Actions → General**
   - Actions permissions: _Allow sanchezign, and select non-sanchezign, actions and reusable
     workflows_ → allow actions created by GitHub, and specify: `pnpm/action-setup@*`,
     `docker/*`, `googleapis/release-please-action@*`.
   - Enable **Require actions to be pinned to a full-length commit SHA**.
   - Artifact and log retention: **14 days**.
   - Fork pull request workflows: require approval for all outside collaborators.
   - Workflow permissions: **Read repository contents and packages permissions** (read-only
     default) and check **Allow GitHub Actions to create and approve pull requests** (needed by
     release-please).
2. **Settings → Secrets and variables → Actions → Variables**: `E2E_POLICY` = `private`.
   No secrets are needed.
3. **Settings → Advanced Security** (Code security): Dependency graph **on**, Dependabot
   alerts **on**; Dependabot security updates and version updates **off** (Renovate).
4. **Install the Mend Renovate app** (github.com/apps/renovate) on **this repository only**.
   `renovate.json` already exists, so it starts without an onboarding PR and opens a
   "Dependency Dashboard" issue.
5. **Billing and plans → Budgets**: Actions and Packages budgets of **$0** with "stop usage"
   so nothing is ever billed.
6. **After the first release**: Profile → Packages → `smartops-api` and `smartops-admin` →
   check visibility **private** and that each is linked to this repository.
7. **At phase close**: the first push to `main` after a rebase-merge must show `main-guard`
   green — it asks the API which PR contains the commit, which can lag a few seconds after the
   merge; if it fails right after a legitimate merge, re-run the job.

When the repository goes public (after the security audit): create a branch ruleset for
`main` (pull request required, required checks, no force push, no deletion), enable secret
scanning + push protection, CodeQL and private vulnerability reporting, and switch
`E2E_POLICY` to `public`.
