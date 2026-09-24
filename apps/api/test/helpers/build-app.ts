import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/common/logger.js";
import { parseEnv } from "../../src/config/env.js";
import type { HealthRepository } from "../../src/modules/health/health.repository.js";
import type {
  SaveWebhookEventInput,
  WhatsAppWebhookRepository,
} from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";

export const TEST_WHATSAPP_APP_SECRET = "test-app-secret-0123456789abcdef";
export const TEST_WHATSAPP_VERIFY_TOKEN = "test-verify-token-0123456789";

/** Fake but schema-valid WhatsApp values (no real credentials). */
export const TEST_WHATSAPP_ENV = {
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_WABA_ID: "200000000000002",
  WHATSAPP_ACCESS_TOKEN: "EAAtest-access-token-not-real",
  WHATSAPP_APP_SECRET: TEST_WHATSAPP_APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: TEST_WHATSAPP_VERIFY_TOKEN,
} as const;

export const TEST_ENV_SOURCE = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/smartops_test",
  CORS_ORIGINS: "http://localhost:3000",
  ...TEST_WHATSAPP_ENV,
} as const;

export const healthyDb: HealthRepository = { ping: async () => {} };
export const downDb: HealthRepository = {
  ping: async () => {
    throw new Error("connection refused");
  },
};

/** In-memory WebhookEvent store mirroring the unique (provider, body_sha256) constraint. */
export function createInMemoryWebhookRepository(): WhatsAppWebhookRepository & {
  events: (SaveWebhookEventInput & { id: string })[];
} {
  const events: (SaveWebhookEventInput & { id: string })[] = [];
  return {
    events,
    async saveEvent(input) {
      if (events.some((e) => e.bodySha256 === input.bodySha256)) return { duplicate: true };
      const id = `evt-${events.length + 1}`;
      events.push({ ...input, id });
      return { duplicate: false, id };
    },
  };
}

/** App with stubbed repositories — no Postgres needed. */
export function buildTestApp(
  options: {
    env?: Record<string, string>;
    healthRepository?: HealthRepository;
    whatsappWebhookRepository?: WhatsAppWebhookRepository;
  } = {},
) {
  const env = parseEnv({ ...TEST_ENV_SOURCE, ...options.env });
  return createApp({
    env,
    logger: createLogger(env),
    healthRepository: options.healthRepository ?? healthyDb,
    whatsappWebhookRepository:
      options.whatsappWebhookRepository ?? createInMemoryWebhookRepository(),
  });
}
