import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/common/logger.js";
import { parseEnv } from "../../src/config/env.js";
import type { WebhookQueue } from "../../src/jobs/queues.js";
import type { HealthRepository } from "../../src/modules/health/health.repository.js";
import type { InternalDeps } from "../../src/modules/internal/internal.routes.js";
import type {
  SaveWebhookEventInput,
  WhatsAppWebhookRepository,
} from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";

export const TEST_WHATSAPP_APP_SECRET = "test-app-secret-0123456789abcdef";
export const TEST_WHATSAPP_VERIFY_TOKEN = "test-verify-token-0123456789";
export const TEST_INTERNAL_API_KEY = "test-internal-api-key-0123456789abcdef";

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
  INTERNAL_API_KEY: TEST_INTERNAL_API_KEY,
  ...TEST_WHATSAPP_ENV,
} as const;

export const healthyDb: HealthRepository = { ping: async () => {} };
export const downDb: HealthRepository = {
  ping: async () => {
    throw new Error("connection refused");
  },
};

type StoredEvent = SaveWebhookEventInput & {
  id: string;
  receivedAt: Date;
  enqueuedAt: Date | null;
};

/** In-memory WebhookEvent store mirroring the unique (provider, body_sha256) constraint. */
export function createInMemoryWebhookRepository(
  options: { now?: () => Date } = {},
): WhatsAppWebhookRepository & { events: StoredEvent[] } {
  const now = options.now ?? (() => new Date());
  const events: StoredEvent[] = [];
  return {
    events,
    async saveEvent(input) {
      if (events.some((e) => e.bodySha256 === input.bodySha256)) return { duplicate: true };
      const id = `evt-${events.length + 1}`;
      events.push({ ...input, id, receivedAt: now(), enqueuedAt: null });
      return { duplicate: false, id };
    },
    async markEnqueued(id) {
      const event = events.find((e) => e.id === id);
      if (event) event.enqueuedAt = now();
    },
    async findUnenqueued({ receivedBefore, limit }) {
      return events
        .filter((e) => e.enqueuedAt === null && e.receivedAt < receivedBefore)
        .slice(0, limit)
        .map((e) => e.id);
    },
  };
}

/** Records enqueued event ids; `failWith` simulates pg-boss being down. */
export function createFakeWebhookQueue(
  options: { failWith?: Error } = {},
): WebhookQueue & { enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    enqueued,
    async enqueueWebhookEvent(eventId) {
      if (options.failWith) throw options.failWith;
      enqueued.push(eventId);
    },
  };
}

const notConfigured = async (): Promise<never> => {
  throw new Error("internal API services are not configured in this test app");
};

/** Internal API stubs (tests that need them pass real services). */
export const stubInternalDeps: InternalDeps = {
  ingestion: { classify: notConfigured, extract: notConfigured },
  catalog: { ingest: notConfigured },
  settings: { getAll: notConfigured, getCatalogSettings: notConfigured },
};

/** App with stubbed repositories — no Postgres needed. */
export function buildTestApp(
  options: {
    env?: Record<string, string>;
    healthRepository?: HealthRepository;
    whatsappWebhookRepository?: WhatsAppWebhookRepository;
    webhookQueue?: WebhookQueue;
    internal?: InternalDeps;
  } = {},
) {
  const env = parseEnv({ ...TEST_ENV_SOURCE, ...options.env });
  return createApp({
    env,
    logger: createLogger(env),
    healthRepository: options.healthRepository ?? healthyDb,
    whatsappWebhookRepository:
      options.whatsappWebhookRepository ?? createInMemoryWebhookRepository(),
    webhookQueue: options.webhookQueue ?? createFakeWebhookQueue(),
    internal: options.internal ?? stubInternalDeps,
  });
}
