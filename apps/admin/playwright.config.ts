import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./e2e/env";

/**
 * Browser E2E (phase 9, user decision): desktop Chromium, mobile Chromium (Pixel 7) and mobile
 * WebKit (iPhone) — the owner uses the panel from a phone. Runs against a freshly SEEDED demo
 * database (the API web server runs demo:seed first — web servers start before any global
 * setup), its own API (:4100) and panel (:3100).
 *
 *   pnpm --filter @smartops/admin e2e
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  outputDir: "e2e/results",
  use: {
    baseURL: E2E.panelUrl,
    locale: "es-UY",
    timezoneId: "America/Montevideo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 15"] } },
  ],
  webServer: [
    {
      command: "pnpm demo:seed && pnpm exec tsx --env-file-if-exists=.env src/server.ts",
      cwd: "../api",
      url: `http://localhost:${E2E.apiPort}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: E2E.databaseUrl,
        DEMO_DATABASE_URL: E2E.databaseUrl,
        DEMO_OPERATOR_EMAIL: E2E.operator.email,
        DEMO_OPERATOR_PASSWORD: E2E.operator.password,
        DEMO_ADMIN_EMAIL: E2E.admin.email,
        DEMO_ADMIN_PASSWORD: E2E.admin.password,
        PORT: String(E2E.apiPort),
        CORS_ORIGINS: E2E.panelUrl,
        LOG_LEVEL: "warn",
        LOGIN_RATE_LIMIT_MAX: "1000",
        // Every browser project hits the API from one IP in a few minutes (not a real-world load).
        RATE_LIMIT_MAX: "100000",
        N8N_DELIVERY_ENABLED: "false",
        AI_PROVIDER: "fake",
        TRANSCRIPTION_PROVIDER: "fake",
      },
    },
    {
      // Production build (deterministic, like the deploy), in its own dist dir.
      command: `pnpm exec next build && pnpm exec next start --port ${E2E.panelPort}`,
      url: `${E2E.panelUrl}/login`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        API_PROXY_TARGET: `http://localhost:${E2E.apiPort}`,
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
