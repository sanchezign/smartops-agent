import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
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
