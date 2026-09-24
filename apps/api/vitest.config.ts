import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Creates + migrates the integration test DB when TEST_DATABASE_URL is set.
    globalSetup: ["test/integration/global-setup.ts"],
  },
});
