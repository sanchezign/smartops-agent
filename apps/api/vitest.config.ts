import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Coverage ratchet (phase 10): measured − 2, only goes up (scripts/coverage-ratchet.mjs). */
const ratchet = JSON.parse(
  readFileSync(new URL("./coverage-thresholds.json", import.meta.url), "utf8"),
) as {
  global: Record<string, number>;
  files: Record<string, Record<string, number>>;
};

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: {
        ...ratchet.global,
        ...Object.fromEntries(Object.entries(ratchet.files).map(([f, t]) => [`src/${f}`, t])),
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/e2e/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Creates + migrates the integration test DB when TEST_DATABASE_URL is set.
          globalSetup: ["test/integration/global-setup.ts"],
          // Files share one database and TRUNCATE it: run them one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
