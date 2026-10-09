# Project history

Closed work, moved out of `CLAUDE.md` on 2026-10-06 so the project memory loaded in every Claude Code
session stays small (it had reached ~206,000 characters; the tool truncates past 150,000 and the
guard test now fails above 45,000). Nothing was rewritten: the files hold the original text, in the
original order.

| File | What it is | Read it when |
|---|---|---|
| [phase-log.md](phase-log.md) | Every phase and milestone as it was built: decisions, measurements, incidents, real results | You need the detail of a closed milestone |
| [phase-order-detail.md](phase-order-detail.md) | The original brief of each phase, with the user decisions added along the way | You need a phase's original requirements |
| [architecture-decisions.md](architecture-decisions.md) | Fine-grained decisions per phase (versions, module rules); the ADRs in `docs/adr/` are the formal records | You are about to change a module and want to know why it is the way it is |
| [resolved-issues.md](resolved-issues.md) | Known issues already resolved or superseded | You meet a symptom and want to know if it was seen before |

Repository history (2026-10): this public repository was created with a rewritten copy of the history of a
private predecessor repository (to remove personal data before publication). Commit references in these
files, `CHANGELOG.md` and the release notes were mapped to the new commits. Pull request numbers
(`#NN`, "PR #NN") written before 2026-10-10, and the few commit hashes that could not be mapped (commits of
feature branches before their rebase-merge, e.g. in phase 11), refer to that predecessor repository, not
to this one.

Rules:

- When a milestone closes, move its detail (textually) to the END of `phase-log.md`; `CLAUDE.md`
  keeps one line and a link.
- When a Known issue is resolved, move its entry to `resolved-issues.md`.
- The guard test `apps/api/test/unit/claude-md.test.ts` checks that `CLAUDE.md` plus these files never
  lose more than 15 % of their lines against `origin/main`, that `phase-log.md` keeps phases 1..N
  without gaps, and that `CLAUDE.md` stays under 45,000 characters.
