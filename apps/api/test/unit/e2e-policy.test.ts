import { describe, expect, it } from "vitest";
import { e2eDecision } from "../../scripts/ci/e2e-policy.js";

/** CI policy of the browser E2E (phase 10 M8): one variable switches private ↔ public. */

describe("E2E policy", () => {
  it.each([
    // [event, baseRef, policy, newCommits, runs]
    ["pull_request", "main", undefined, 0, true],
    ["pull_request", "feat/x", undefined, 0, false],
    ["pull_request", "feat/x", "private", 0, false],
    ["pull_request", "feat/x", "public", 0, true],
    ["pull_request", "main", "public", 0, true],
    ["schedule", undefined, "private", 3, true],
    ["schedule", undefined, "private", 0, false],
    ["schedule", undefined, "public", 0, false],
    ["workflow_dispatch", undefined, "private", 0, true],
    ["push", undefined, "public", 5, false],
    ["pull_request", "feat/x", "PUBLIC", 0, false], // unknown value → the cheap default
  ] as const)(
    "%s → %s (policy %s, %s new commits) runs: %s",
    (event, baseRef, policy, newCommits, runs) => {
      expect(e2eDecision({ event, baseRef, policy, newCommits }).run).toBe(runs);
    },
  );

  it("always explains the decision", () => {
    expect(e2eDecision({ event: "schedule", newCommits: 0 }).reason).toMatch(/no new commits/);
  });
});
