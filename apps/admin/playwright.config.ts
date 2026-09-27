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
const API_ENV = apiEnv();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  // CI: one retry; a test that only passes on the retry is reported as FLAKY (list summary +
  // a GitHub annotation), never silently green. Locally: no retries (fix it, do not retry it).
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "e2e/report" }],
    ...(process.env.CI ? ([["github"]] as const) : []),
  ],
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
      env: API_ENV,
    },
    {
      // Plays n8n (the exported workflows, over HTTP) and runs the REAL worker (phase 9 M8).
      command: "pnpm exec tsx --env-file-if-exists=.env scripts/demo/e2e-n8n.ts",
      cwd: "../api",
      url: "http://127.0.0.1:4110/health",
      reuseExistingServer: false,
      timeout: 300_000,
      env: { ...API_ENV, API_URL: `http://127.0.0.1:${E2E.apiPort}`, N8N_FAKE_PORT: "4110" },
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

/** The E2E API runs the PUBLIC DEMO (DEMO_MODE) on its own *_demo database. */
function apiEnv(): Record<string, string> {
  return {
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
    DEMO_MODE: "true",
    DEMO_E2E_REVIEWS: "true",
    DEMO_RESET_INTERVAL_MINUTES: "0",
    DEMO_RATE_LIMIT_MAX: "1000",
    N8N_DELIVERY_ENABLED: "true",
    N8N_RECEIVER_WEBHOOK_URL: "http://127.0.0.1:4110/webhook/smartops-message-ready",
    N8N_WEBHOOK_SECRET: "e2e-fake-n8n-secret-0000000000000000",
    // Self-contained (phase 10 M8): the E2E never needs — nor inherits — the developer's real
    // keys from apps/api/.env (these win over the env file), so it runs in CI as-is. DEMO_MODE
    // forces the fake LLM / transcriber and blocks every Meta host anyway.
    WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
    WHATSAPP_WABA_ID: "200000000000002",
    WHATSAPP_ACCESS_TOKEN: "e2e-fake-whatsapp-access-token",
    WHATSAPP_APP_SECRET: "e2e-fake-whatsapp-app-secret-00",
    WHATSAPP_VERIFY_TOKEN: "e2e-fake-verify-token-000000",
    INTERNAL_API_KEY: "e2e-fake-internal-api-key-000000000000",
    JWT_ACCESS_SECRET: "e2e-fake-jwt-access-secret-00000000000",
    AI_PROVIDER: "fake",
    TRANSCRIPTION_PROVIDER: "fake",
    // Empty = unset (optionalString): real provider keys of the .env never reach the E2E API.
    ANTHROPIC_API_KEY: "",
    TRANSCRIPTION_API_KEY: "",
  };
}
