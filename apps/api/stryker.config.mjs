// @ts-check
/**
 * Mutation testing of the critical PURE modules (phase 10 M9) — report only, no gate (user
 * decision). Run: pnpm --filter @smartops/api mutation
 *
 * Command runner, NOT @stryker-mutator/vitest-runner: on Vitest 5 the vitest-runner 10.0.0
 * filters tests by name with the old separator, runs ZERO tests per mutant and reports every
 * mutant as survived (stryker-js#6210, fix in PR #6220, unreleased as of 2026-09-27). The
 * command runner runs the whole unit suite per mutant (slower, correct). Switch back to the
 * vitest-runner (perTest coverage, much faster) once a release contains the fix.
 */

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "command",
  commandRunner: { command: "pnpm exec vitest run --config vitest.stryker.config.ts" },
  coverageAnalysis: "off",
  mutate: [
    "src/modules/catalog/price-math.ts",
    "src/modules/sheets/sheet-values.ts",
    "src/modules/auth/session-rules.ts",
    "src/modules/auth/login-lockout.ts",
    "src/modules/optout/optout-detector.ts",
    "src/modules/whatsapp/message-status.ts",
    "src/modules/notifications/digest-rules.ts",
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  concurrency: 4,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
