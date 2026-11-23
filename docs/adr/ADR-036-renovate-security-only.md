# ADR-036: Renovate opens security fix pull requests only

Date: 2026-11-23
Status: accepted (the owner's decision, 2026-11-23). Amends ADR-028 (point 5, the daily base image digest PRs) and
the Renovate part of ADR-022.

## Context

The project is a finished portfolio demo (phases 1–16 closed). Weekly non-major groups, daily `node` / `postgres`
digest PRs and the monthly lockfile maintenance kept producing pull requests and CI minutes for updates that fix
nothing. The owner wants as few updates as possible.

What the official Renovate documentation and source say (checked 2026-11-23):

- [`vulnerabilityAlerts`](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts): "If you want
  to raise only vulnerability fix PRs, you may use the `security:only-security-updates` preset." The same section:
  Renovate "always ignores `commitHourlyLimit`, `prHourlyLimit`, `prCommitsPerRunLimit` and `schedule` for
  vulnerability alerts", and (`prConcurrentLimit`) "Renovate always creates security PRs, even if the concurrent PR
  limit is already reached."
- The preset ([`security:only-security-updates`](https://docs.renovatebot.com/presets-security/)) is
  `osvVulnerabilityAlerts: true`, one rule `{ matchPackageNames: ["*"], enabled: false }` and
  `vulnerabilityAlerts: { enabled: true }`.
- Why that works (Renovate source, `lib/workers/repository/init/vulnerability.ts` and
  `process/vulnerabilities.ts`): each alert becomes a package rule with `force: { ...vulnerabilityAlerts }`, and
  `force` overrides the `enabled: false` of the catch-all rule. So `vulnerabilityAlerts.enabled: true` must be
  explicit.
- Sources of the alerts: GitHub's Dependabot alerts (direct dependencies only in this repository, ADR-028) and OSV
  (`osvVulnerabilityAlerts`), which per the docs covers direct dependencies only and does not query the `docker`
  datasource.

## Decision

1. Since 2026-11-23 `renovate.json` disables every normal update: one first package rule
   `{ "matchPackageNames": ["*"], "enabled": false }` (majors, minors, patches, pins, digests, Docker images, GitHub
   Actions, tool images) and `lockFileMaintenance.enabled: false`.
2. Security fix pull requests stay on: `vulnerabilityAlerts.enabled: true` (label `security`, release age 1 day)
   and `osvVulnerabilityAlerts: true`. The rule is inlined (not `extends` of the preset) so the guard test
   `renovate-config.test.ts` can check it.
3. The other rules stay as they were: they no longer create PRs, but they still shape the security PRs. In
   particular the automerge rule is kept on purpose: a security fix that is a `patch` of an npm package (not a
   pinned one) still merges itself through GitHub's auto-merge once the required checks pass.
4. ADR-028 point 5 (daily `node` / `postgres` digest PRs) no longer happens. **Docker base images and transitive
   (indirect) dependencies are covered ONLY by the nightly scan** (`security.yml`, Trivy on the published images
   and the strict `pnpm audit`): when it turns red, the fix is a pull request by hand (new image digest,
   `pnpm update <pkg> -r` or an override).

## Consequences

- Far fewer pull requests and CI minutes; pinned decisions (Prisma 7.10, ESLint 9, Next 15.5, Node 24,
  Postgres 17) no longer get even minor / patch proposals.
- A Debian / Alpine security rebuild of `node` or `postgres` reaches us only after a red nightly run and a manual
  digest bump (before: a daily PR).
- GitHub Actions, the n8n image and the tool images (actionlint, zizmor, gitleaks, Trivy) are no longer updated at
  all unless a GitHub advisory covers them; upgrading them is a planned manual task.
- The project drifts behind upstream; a later upgrade can be larger. Re-enable normal updates (delete the catch-all
  rule) before a real client if regular upgrades are wanted.
- Requirement kept from the docs: Dependency graph + Dependabot alerts on, and the Mend Renovate app with `read`
  access to "Dependabot alerts".
