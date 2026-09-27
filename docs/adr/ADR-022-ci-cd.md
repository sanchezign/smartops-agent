# ADR-022: CI/CD on GitHub Actions for a private repo on GitHub Free

Date: 2026-09-27
Status: accepted

## Context

Phase 11 adds CI/CD. Constraints:

- $0: the repository is private on GitHub Free (2,000 Linux minutes / month, rounded up per
  job). Branch protection / rulesets, CodeQL, GitHub secret scanning / push protection,
  dependency-review and artifact attestations are not available on private repos on this plan.
- No real key in CI (user rule): tests, E2E and container smoke tests must run with fakes.
- The phase 12 target is an ARM VM (Oracle Always Free) or Render, so images must exist for
  arm64 and amd64.
- Dependabot cannot update pnpm 12 lockfiles.

## Decision

- **GitHub Actions**, three workflows (details in `docs/ci-cd.md`):
  - `ci.yml`: a `quick` job on every push (workflow lint, secrets on new commits, audit gate,
    format, lint, typecheck, fast tests);
  - `ci.yml` slow jobs on PRs to `main`, manual runs and a nightly run with new commits:
    Postgres service → coverage gate + build; E2E per the `E2E_POLICY` variable; image checks
    when Docker inputs change;
  - `release.yml`: release-please + images;
  - `security.yml`: weekly full-history secret scan + audit.
- **Soft enforcement of `main`** instead of branch protection: a `main-guard` job fails when a
  pushed commit is not part of a merged PR, plus a local pre-push hook. Real rulesets when the
  repo goes public (after a separate security audit).
- **Rebase-merge** of phase PRs, merged only when the maintainer says so.
- **Additional tools (stack deviations), all free, pinned by SHA or digest:**
  - Renovate (Mend app): dependency PRs; replaces Dependabot version updates;
  - gitleaks: secret scanning, replaces GitHub secret scanning while private;
  - release-please: versions, tags, changelog;
  - Trivy: OS-package vulnerabilities in the images;
  - actionlint + zizmor: workflow correctness and security lint.
- **First-party `pnpm audit` gate** with an exceptions file (justification + expiry).
- **One version for the whole repository**, starting at 0.11.0 (forced once with a
  `Release-As` commit footer); v1.0.0 reserved for the audited public demo.
- **Docker images** in the repo: API (one image: server, worker, migrations) and panel (Next.js
  standalone). Built natively on amd64 and arm64 runners (no QEMU), checked before any push (no
  `.env` / keys / secrets inside, container smoke tests with fake values, Trivy), pushed by
  digest to GHCR with SBOM + provenance, merged into multi-arch tags `X.Y.Z`, `X.Y`,
  `sha-xxxxxxx`. Private while the repo is private.
- **No deploy from CI yet** (phase 12).

## Reason

- Everything above is free for a private repository; each missing GitHub feature has a free,
  pinned substitute that keeps working once the repo is public.
- Splitting `quick` (every push, ~2 min) from the slow suite keeps the monthly budget around
  half the quota while `main` still gets the full suite before every merge.
- Checking the exact image that is pushed (build → checks → push from the same builder cache)
  means nothing unverified reaches the registry.
- Native arm64 builds avoid slow and flaky emulation and match the phase 12 VM.

## Consequences

- Main is only protected by convention + a failing check until the repo is public; a direct
  push is detected, not prevented.
- Release PRs created with `GITHUB_TOKEN` get no CI checks (GitHub rule); the release run
  itself re-checks every image.
- Renovate does not read pnpm's `minimumReleaseAge`; its own `minimumReleaseAge` (3 days, 1 for
  security fixes) is configured to match the intent.
- Accepted audit exceptions expire (currently 2026-10-31) and then block CI again by design.
- Tool upgrades arrive as Renovate PRs; every pinned SHA / digest must keep its version comment.
- Minutes must be watched while private; the `E2E_POLICY` variable and the budget of $0 are
  the controls.
