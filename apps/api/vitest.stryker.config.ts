import { defineConfig } from "vitest/config";

/**
 * Vitest config for mutation testing only (phase 10 M9, `pnpm mutation`): the fast unit suite,
 * no projects, no integration (Stryker re-runs the tests for every mutant; they must be quick
 * and need no database).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    // Tests that read files OUTSIDE apps/api (git history, CLAUDE.md, n8n/workflows, the panel)
    // cannot run in Stryker's sandbox, and none of them exercises the mutated modules.
    exclude: [
      "test/unit/claude-md.test.ts",
      "test/unit/coverage-thresholds.test.ts",
      "test/unit/n8n-contract.test.ts",
      "test/unit/n8n-workflows.test.ts",
      "test/unit/review-permissions-sync.test.ts",
    ],
  },
});
