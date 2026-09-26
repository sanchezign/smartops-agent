import nodeCrypto from "node:crypto";
import { createAuthService } from "./modules/auth/auth.service.js";
import { createSessionsRepository } from "./modules/auth/sessions.repository.js";
import { createAccessTokens } from "./modules/auth/tokens.js";
import { createUsersRepository } from "./modules/users/users.repository.js";
import { createAiClient } from "./ai/ai.client.js";
import { createLlmProvider } from "./ai/ai.factory.js";
import { loadPrompt } from "./ai/prompts.js";
import { createAiUsageRepository } from "./ai/usage.repository.js";
import { createApp } from "./app.js";
import { createPrismaClient } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import {
  createEnqueueN8nDeliveryInTx,
  createEnqueueOutboundInTx,
  createPgBossWebhookQueue,
  createScheduleBotResumeInTx,
  createScheduleDigestInTx,
  startBoss,
} from "./jobs/boss.js";
import { createRunRetrigger } from "./modules/admin/run-retrigger.js";
import { createConversationModeRepository } from "./modules/conversations/conversation-mode.repository.js";
import { createConversationModeService } from "./modules/conversations/conversation-mode.service.js";
import { createHumanReplyService } from "./modules/conversations/human-reply.service.js";
import { createEmitMessageReadyInTx } from "./modules/integration/message-ready.js";
import { createOptOutRepository } from "./modules/optout/optout.repository.js";
import { createReviewRepository } from "./modules/reviews/review.repository.js";
import { createReviewService } from "./modules/reviews/review.service.js";
import { createUsersService } from "./modules/users/users.service.js";
import { createOutboundRepository } from "./modules/messaging/outbound.repository.js";
import { createOutboundService } from "./modules/messaging/outbound.service.js";
import { createNotificationRepository } from "./modules/notifications/notification.repository.js";
import { createNotificationService } from "./modules/notifications/notification.service.js";
import { createSupplierAckService } from "./modules/notifications/supplier-ack.js";
import { createWhatsAppSendClient } from "./modules/whatsapp/whatsapp-send.client.js";
import { createCatalogIngestService } from "./modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "./modules/catalog/catalog.repository.js";
import { FAKE_RESPONDERS } from "./modules/extraction/fake-responders.js";
import { createIngestionRepository } from "./modules/extraction/ingestion.repository.js";
import { createIngestionService } from "./modules/extraction/ingestion.service.js";
import { createHealthRepository } from "./modules/health/health.repository.js";
import { createPostgresMediaStorage } from "./modules/media/media-storage.js";
import { createSheetExtraction } from "./modules/sheets/sheet-extraction.js";
import { createSheetFormatRepository } from "./modules/sheets/sheet-format.repository.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "./modules/settings/settings.service.js";
import { createWhatsAppWebhookRepository } from "./modules/whatsapp/whatsapp-webhook.repository.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Panel passwords use Node's built-in Argon2id (stable since 24.19, ADR-018).
if (typeof nodeCrypto.argon2 !== "function") {
  process.stderr.write(`Node ${process.version} has no crypto.argon2: use Node >= 24.19\n`);
  process.exit(1);
}
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
const ai = createAiClient({
  provider: createLlmProvider(env, FAKE_RESPONDERS),
  usage: createAiUsageRepository(prisma),
  limits: {
    totalUsd: env.AI_TOTAL_BUDGET_USD,
    dailyUsd: env.AI_DAILY_BUDGET_USD,
    dailyExtractionsPerContact: env.AI_DAILY_LIMIT_PER_CONTACT,
    runUsd: env.AI_MAX_RUN_USD,
  },
});
const ingestion = createIngestionService({
  repository: createIngestionRepository(prisma),
  storage: createPostgresMediaStorage(prisma),
  ai,
  // Spreadsheets (M3c): remembered formats per supplier, deterministic read, compact matching.
  sheets: createSheetExtraction({
    ai,
    formats: createSheetFormatRepository(prisma),
    prompts: { mapper: loadPrompt("column-mapper"), matcher: loadPrompt("matcher") },
    models: {
      mapper: env.AI_EXTRACTOR_MODEL,
      matcher: env.AI_EXTRACTOR_MODEL,
      cacheSystemPrompts: env.AI_PROMPT_CACHE,
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

// Notifications (phase 6): the API records items and schedules digests; the worker sends.
const notificationRepository = createNotificationRepository(prisma, {
  scheduleDigestInTx: createScheduleDigestInTx(boss),
});
const notifications = createNotificationService({ repository: notificationRepository, settings });
const outbound = createOutboundService({
  repository: createOutboundRepository(prisma, {
    enqueueOutboundInTx: createEnqueueOutboundInTx(boss),
  }),
  client: createWhatsAppSendClient({
    graph: {
      baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
      version: env.WHATSAPP_GRAPH_API_VERSION,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      timeoutMs: env.WHATSAPP_API_TIMEOUT_MS,
    },
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  }),
  // Opt-out instruction on auto replies (ADR-017): the supplier ack is sent from here.
  settings,
});
// Panel auth (phase 8, ADR-018).
const sessionsRepository = createSessionsRepository(prisma);
const usersRepository = createUsersRepository(prisma, {
  revokeUserSessionsInTx: sessionsRepository.revokeAllForUserInTx,
});
const auth = createAuthService({
  users: usersRepository,
  sessions: sessionsRepository,
  tokens: createAccessTokens({
    secret: env.JWT_ACCESS_SECRET,
    ttlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  }),
  config: { idleHours: env.SESSION_IDLE_HOURS, maxDays: env.SESSION_MAX_DAYS },
});

const conversationMode = createConversationModeService({
  repository: createConversationModeRepository(prisma, {
    scheduleBotResumeInTx: createScheduleBotResumeInTx(boss),
  }),
  settings,
});

const supplierAck = createSupplierAckService({
  repository: notificationRepository,
  settings,
  outbound,
});

const app = createApp({
  env,
  logger,
  healthRepository,
  whatsappWebhookRepository: createWhatsAppWebhookRepository(prisma),
  webhookQueue: createPgBossWebhookQueue(boss),
  internal: { ingestion, catalog, settings, notifications, supplierAck },
  auth,
  // Panel API (phase 8 M4): the same services the CLIs use, behind roles.
  admin: {
    reviews: createReviewService({
      repository: createReviewRepository(prisma),
      ingest: catalog,
      settings,
      catalog: createCatalogRepository(prisma),
    }),
    retriggerRun: createRunRetrigger({
      prisma,
      emitMessageReadyInTx: createEmitMessageReadyInTx(createEnqueueN8nDeliveryInTx(boss)),
    }),
    mode: conversationMode,
    humanReply: createHumanReplyService({ outbound, mode: conversationMode }),
    consent: createOptOutRepository(prisma),
    settings,
    users: createUsersService({ repository: usersRepository }),
    sessions: sessionsRepository,
  },
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
