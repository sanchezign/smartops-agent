/**
 * When the browser E2E runs in CI (phase 10 M8; the GitHub Actions YAML is phase 11).
 * ONE repository variable switches the policy:
 *
 *   E2E_POLICY=private (default) — the repo is private (2,000 free Linux minutes / month):
 *     pull requests TO main, manual runs, and the nightly schedule ONLY when main got new
 *     commits in the last 24 h.
 *   E2E_POLICY=public — the repo is public (standard runners are free): every pull request,
 *     manual runs and the nightly schedule (same new-commits rule: nothing to test otherwise).
 *
 * Pushes never run it (the pull request already did). Usage in a workflow step:
 *   NEW_COMMITS=$(git log --since="24 hours ago" --oneline origin/main | wc -l) \
 *   pnpm --filter @smartops/api exec tsx scripts/ci/e2e-policy.ts
 * → prints the decision and writes `run=true|false` to $GITHUB_OUTPUT when it exists.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type E2ePolicy = "private" | "public";

export interface E2eContext {
  /** GITHUB_EVENT_NAME */
  event: string;
  /** GITHUB_BASE_REF (pull requests only). */
  baseRef?: string | undefined;
  /** vars.E2E_POLICY; anything else (or unset) → private, the cheaper default. */
  policy?: string | undefined;
  /** Commits on main in the last 24 h (nightly runs). */
  newCommits?: number | undefined;
}

export function e2eDecision(ctx: E2eContext): { run: boolean; reason: string } {
  const policy: E2ePolicy = ctx.policy === "public" ? "public" : "private";
  switch (ctx.event) {
    case "workflow_dispatch":
      return { run: true, reason: "manual run" };
    case "schedule":
      return (ctx.newCommits ?? 0) > 0
        ? { run: true, reason: `nightly: ${ctx.newCommits} new commit(s) on main` }
        : { run: false, reason: "nightly: no new commits on main in 24 h" };
    case "pull_request":
      if (policy === "public") return { run: true, reason: "public repo: every pull request" };
      return ctx.baseRef === "main"
        ? { run: true, reason: "private repo: pull request to main" }
        : {
            run: false,
            reason: `private repo: pull request to ${ctx.baseRef ?? "?"} (E2E only on main)`,
          };
    default:
      return { run: false, reason: `event ${ctx.event}: E2E not needed` };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const decision = e2eDecision({
    event: process.env.GITHUB_EVENT_NAME ?? "",
    baseRef: process.env.GITHUB_BASE_REF,
    policy: process.env.E2E_POLICY,
    newCommits: Number(process.env.NEW_COMMITS ?? "0"),
  });
  process.stdout.write(`E2E ${decision.run ? "RUNS" : "skipped"}: ${decision.reason}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
}
