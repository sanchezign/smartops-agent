import { createAiClient } from "./ai/ai.client.js";
import { createLlmProvider } from "./ai/ai.factory.js";
import { loadPrompt } from "./ai/prompts.js";
import { createAiUsageRepository } from "./ai/usage.repository.js";
import { createApp } from "./app.js";
import { createPrismaClient } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import { createPgBossWebhookQueue, startBoss } from "./jobs/boss.js";
import { createCatalogIngestService } from "./modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "./modules/catalog/catalog.repository.js";
import { FAKE_RESPONDERS } from "./modules/extraction/fake-responders.js";
import { createIngestionRepository } from "./modules/extraction/ingestion.repository.js";
import { createIngestionService } from "./modules/extraction/ingestion.service.js";
import { createHealthRepository } from "./modules/health/health.repository.js";
import { createPostgresMediaStorage } from "./modules/media/media-storage.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "./modules/settings/settings.service.js";
import { createWhatsAppWebhookRepository } from "./modules/whatsapp/whatsapp-webhook.repository.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL, logger);
const healthRepository = createHealthRepository(prisma);

// Fail fast if the database is unreachable at startup (Render restarts the service).
try {
  await prisma.$connect();
  await healthRepository.ping();
  logger.info("database connected");
} catch (err) {
  logger.fatal({ err }, "database connection failed on startup");
  process.exit(1);
}

// pg-boss (send-only in the API). Fail fast: without it webhooks could not be queued.
let boss: Awaited<ReturnType<typeof startBoss>>;
try {
  boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "api" });
  logger.info("job queue ready");
} catch (err) {
  logger.fatal({ err }, "job queue (pg-boss) failed to start");
  process.exit(1);
}

// Classification / extraction / catalog ingest (phase 5), exposed to n8n via /internal.
const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
const ingestion = createIngestionService({
  repository: createIngestionRepository(prisma),
  storage: createPostgresMediaStorage(prisma),
  ai: createAiClient({
    provider: createLlmProvider(env, FAKE_RESPONDERS),
    usage: createAiUsageRepository(prisma),
    limits: {
      totalUsd: env.AI_TOTAL_BUDGET_USD,
      dailyUsd: env.AI_DAILY_BUDGET_USD,
      dailyExtractionsPerContact: env.AI_DAILY_LIMIT_PER_CONTACT,
      runUsd: env.AI_MAX_RUN_USD,
    },
  }),
  prompts: { classifier: loadPrompt("classifier"), extractor: loadPrompt("extractor") },
  models: {
    classifier: env.AI_CLASSIFIER_MODEL,
    extractor: env.AI_EXTRACTOR_MODEL,
    cacheSystemPrompts: env.AI_PROMPT_CACHE,
  },
});
const catalog = createCatalogIngestService({
  repository: createCatalogRepository(prisma),
  settings,
});

const app = createApp({
  env,
  logger,
  healthRepository,
  whatsappWebhookRepository: createWhatsAppWebhookRepository(prisma),
  webhookQueue: createPgBossWebhookQueue(boss),
  internal: { ingestion, catalog, settings },
});
const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `api listening on http://localhost:${env.PORT}`,
  );
});

let shuttingDown = false;

function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, "shutting down");

  setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(() => {
    boss
      .stop({ graceful: true, timeout: 5_000 })
      .catch((err: unknown) => logger.error({ err }, "error stopping pg-boss"))
      .then(() => prisma.$disconnect())
      .catch((err: unknown) => logger.error({ err }, "error disconnecting prisma"))
      .finally(() => process.exit(exitCode));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});
