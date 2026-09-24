import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/common/logger.js";
import { parseEnv } from "../../src/config/env.js";
import type { HealthRepository } from "../../src/modules/health/health.repository.js";

export const TEST_ENV_SOURCE = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/smartops_test",
  CORS_ORIGINS: "http://localhost:3000",
} as const;

export const healthyDb: HealthRepository = { ping: async () => {} };
export const downDb: HealthRepository = {
  ping: async () => {
    throw new Error("connection refused");
  },
};

/** App with a stubbed DB — no Postgres needed. */
export function buildTestApp(
  options: { env?: Record<string, string>; healthRepository?: HealthRepository } = {},
) {
  const env = parseEnv({ ...TEST_ENV_SOURCE, ...options.env });
  return createApp({
    env,
    logger: createLogger(env),
    healthRepository: options.healthRepository ?? healthyDb,
  });
}
