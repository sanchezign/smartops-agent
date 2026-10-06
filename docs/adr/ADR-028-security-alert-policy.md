# ADR-028: Security alerts — pull requests block what they introduce, a nightly scan owns what already exists

Date: 2026-10-06
Status: accepted (the owner's decision, 2026-10-06, reduced scope). Refines ADR-022 (CI/CD).

## Context

Until now every gate was absolute: `quick` failed on ANY unexcepted HIGH/CRITICAL `pnpm audit --prod` finding
and the `images` job failed on ANY fixable HIGH/CRITICAL OS finding. A new advisory published on the internet
therefore turned every pull request red — docs-only ones included — and stopped the project. It happened three
times on 2026-10-06 (sharp / source-map-js, Perl in the Debian base image, `@modelcontextprotocol/sdk`). The
change did not cause any of them, and the person who is blocked cannot fix a world event inside an unrelated PR.

Findings of the research behind this decision (2026-10-06):

- GitHub's dependency graph of this repository lists only 94 packages (direct dependencies); the Dependabot alerts
  API returns none, although three advisories were open that day. Renovate's `vulnerabilityAlerts` reads exactly
  those alerts ([docs](https://docs.renovatebot.com/configuration-options/)), so it does not see transitive
  dependencies here. `osvVulnerabilityAlerts` is experimental and, per the same docs, only queries direct
  dependencies. `pnpm audit` (the whole lockfile) stays the only detector of transitive advisories.
- Renovate's `minimumReleaseAge` needs a release timestamp; with `minimumReleaseAgeBehaviour=timestamp-required`
  (what it ran with in a local dry run) a release without one is "pending". Docker digests carry none.
- GitHub native auto-merge needs branch protection, which a private repository on GitHub Free does not have.

## Decision

1. **Pull requests block only what the change introduces.** `audit-gate.ts --base auto` (job `quick`) audits the
   base (merge-base with `origin/main`, or the previous tip of `main` on a push to `main`) and the head; a
   HIGH/CRITICAL finding whose (advisory, package, version) is absent from the base and has no valid exception
   blocks. Findings already in the base are warnings ("pre-existing"). Same lockfile and manifests as the base:
   one audit, nothing can be introduced. Base unresolvable: strict. Without `--base` it is strict.
2. **Trivy in the `images` job of pull requests is a warning annotation.** `release.yml` still blocks on the same
   findings (a test checks both): nothing with a fixable HIGH/CRITICAL OS finding is published unnoticed.
3. **Exceptions have a maximum life**, by severity, counted from `addedAt`: CRITICAL ≤ 7 days, HIGH ≤ 30 days. Each
   exception (pnpm audit and image) carries its `severity`; a `high` exception does not cover a critical advisory
   (a re-rating needs a new 7-day review). A test enforces it. The four pnpm audit exceptions (added 2026-09-27,
   10-31 = 34 days) were shortened to 2026-10-27.
4. **A nightly scan of what already exists** (`security.yml`, job `nightly-scan`, 06:30 UTC): the strict audit gate on
   main's lockfile, and Trivy (OS packages AND libraries, fixable HIGH/CRITICAL, `.trivyignore`) on the **published**
   images of the latest release — `ghcr.io/<owner>/smartops-{api,admin}:<version of the latest GitHub release>`
   (the images carry no `latest` tag). Trivy pulls them with the job's own `GITHUB_TOKEN` (`packages: read`; verified
   on 2026-10-06 that this works for the private images, so no image is built from `main`). A finding, a scan that
   cannot run, or a report that proves no OS scan happened turns the run **red**; GitHub's e-mail about the failed
   scheduled run is the notification. `trivy-gate.ts` fails closed (Trivy runs with `--exit-code 0`, so its own
   status only means "the scan failed", and the report is judged by the script).
   The four library findings Trivy reports (deepmerge-ts, mysql2, postcss ×2) are mirrored from the pnpm audit
   exceptions into `.trivyignore` / `imageExceptions` with the same expiry.
5. **Renovate reviews the `node` and `postgres` image digests every day** (`before 6am`, own PR "base image
   digests"), without automerge — the owner merges every dependency PR. `minimumReleaseAgeBehaviour:
timestamp-optional` is set for these two images only, because digests have no timestamp; everything else keeps
   the strict 3-day age.

Out of scope on purpose (reduced scope, 2026-10-06): automatic GitHub issues with deadlines, a heartbeat for the
scan, automerge, and a "release blocks only what it introduces" rule. The release keeps blocking as before.

## Risks (what could go wrong without anyone noticing)

- **Blind spot of the diff.** What is already in `main` never turns a pull request red; the nightly scan is the only
  owner of it. If that scan stops running, nothing else tells us. The first line of defence is the e-mail of a failed
  run; a scan that never starts sends no e-mail (see "Is the nightly scan still running?" in `docs/ci-cd.md`).
- **Public repository: scheduled workflows are disabled after 60 days without repository activity** (GitHub docs,
  [Disable and enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)).
  It applies once the repository is public; a private one is not affected. A disabled workflow has the state
  `disabled_inactivity` in the REST API; detect it with
  `gh api repos/<owner>/<repo>/actions/workflows --jq '.workflows[] | select(.state != "active") | [.name, .state] | @tsv'`
  and re-enable it with `gh workflow enable security.yml`. Any commit counts as activity; the runs of the workflow
  itself do not.
- **Published image vs deployed image.** The scan reads the latest release. What runs on the VM is deployed by hand
  and may be older: a fix that is released but not deployed stays invisible to CI.
- **A fix merged to `main` and not released** shows as clean in the audit and as vulnerable in the published image
  until the next release.
- **Exceptions are the way out of a red nightly run.** They are time-boxed (7 / 30 days) and need a reason, but an
  exception added carelessly silences the scan; they are reviewed by the owner in the pull request.
- **Strict audit also runs weekly** in the `security` job (kept as it was): two red runs on the same Monday for one
  advisory are possible and are the same finding.
- **Transitive advisories need a human.** Renovate neither sees nor fixes them; the nightly scan reports them and the
  fix (`pnpm update <pkg> -r`, or an override when the parent pins it) is a pull request by hand.
- **Digest PRs are not security-aware.** Renovate proposes any new digest of the two images; whether it fixes the
  CVE shows in the pull request's Trivy warning and in the next nightly run.
- **Time zone of "today".** The audit and the exceptions' expiry use UTC dates.

## Consequences

- A pull request is red only for a real reason of its own: `main` is no longer held hostage by the world.
- The cost of the nightly scan is 2 billed minutes per run (measured 2026-10-06: the job took 64 s and is rounded
  up), about 60 minutes a month on top of the 830 estimated in `docs/ci-cd.md`, so about 890 of the 2,000 included.
  The weekly gitleaks job (30 s, 1 billed minute) is unchanged.
- The date to watch moves from "the day the exceptions expire" to "the first red nightly run after 2026-10-27".
