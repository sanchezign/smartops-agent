import { createPrismaClient } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import {
  createEnqueueDocumentConversionInTx,
  createEnqueueN8nDeliveryInTx,
  createScheduleBotResumeInTx,
  createScheduleDigestInTx,
  enqueueN8nDelivery,
  createEnqueueMediaInTx,
  createEnqueueOutboundInTx,
  createEnqueueTranscriptionInTx,
  createPgBossWebhookQueue,
  startBoss,
} from "./jobs/boss.js";
import { registerConversationModeWorkers } from "./jobs/conversation-mode.job.js";
import { registerDocumentConversionWorkers } from "./jobs/document-conversion.job.js";
import { registerMediaTranscriptionWorkers } from "./jobs/media-transcription.job.js";
import { registerN8nDeliveryWorkers } from "./jobs/n8n-delivery.job.js";
import { registerNotificationDigestWorkers } from "./jobs/notification-digest.job.js";
import { createConversationModeRepository } from "./modules/conversations/conversation-mode.repository.js";
import {
  createConversationModeService,
  createOnHumanMessageInTx,
} from "./modules/conversations/conversation-mode.service.js";
import { createNotificationRepository } from "./modules/notifications/notification.repository.js";
import { createNotificationService } from "./modules/notifications/notification.service.js";
import { createIntegrationEventRepository } from "./modules/integration/integration-event.repository.js";
import { createEmitMessageReadyInTx } from "./modules/integration/message-ready.js";
import {
  createN8nClient,
  createN8nDeliveryService,
  createN8nWatchdog,
} from "./modules/integration/n8n-delivery.js";
import { registerWhatsAppMediaWorkers } from "./jobs/whatsapp-media.job.js";
import { registerWhatsAppOutboundWorkers } from "./jobs/whatsapp-outbound.job.js";
import { registerWhatsAppWebhookWorkers } from "./jobs/whatsapp-webhook.job.js";
import { createPostgresMediaStorage } from "./modules/media/media-storage.js";
import {
  createDocumentConversionRepository,
  createOnDocumentStoredInTx,
} from "./modules/documents/document-conversion.repository.js";
import { createDocumentConversionService } from "./modules/documents/document-conversion.service.js";
import { createIsolatedDocumentConverter } from "./modules/documents/document-converter.js";
import { DEFAULT_CONVERSION_LIMITS } from "./modules/documents/document-types.js";
import {
  composeOnStoredInTx,
  createMediaRepository,
  createOnReadyMediaStoredInTx,
} from "./modules/media/media.repository.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "./modules/settings/settings.service.js";
import { createMediaDownloadService } from "./modules/media/media.service.js";
import { createOutboundRepository } from "./modules/messaging/outbound.repository.js";
import { createOutboundService } from "./modules/messaging/outbound.service.js";
import {
  createTranscriber,
  loadVocabularyPrompt,
} from "./modules/transcription/transcriber.factory.js";
import {
  createOnAudioStoredInTx,
  createTranscriptionRepository,
} from "./modules/transcription/transcription.repository.js";
import { createTranscriptionService } from "./modules/transcription/transcription.service.js";
import { createWebhookSweeper } from "./modules/whatsapp/webhook-sweeper.js";
import { createWhatsAppMediaClient } from "./modules/whatsapp/whatsapp-media.client.js";
import { createWhatsAppSendClient } from "./modules/whatsapp/whatsapp-send.client.js";
import { createWhatsAppIngestRepository } from "./modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "./modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "./modules/whatsapp/whatsapp-webhook.repository.js";

/**
 * Worker process: consumes pg-boss queues (webhook processing, media downloads,
 * outbound sends, voice-note transcription, dead letters, sweeper).
 * Separate from the HTTP server so slow jobs never delay webhook acks.
 */

const SHUTDOWN_TIMEOUT_MS = 30_000;
/** Time given to in-flight jobs on shutdown (jobs expire after 60 s anyway). */
const BOSS_STOP_TIMEOUT_MS = 20_000;

const env = loadEnv();
const logger = createLogger(env, "worker");
const prisma = createPrismaClient(env.DATABASE_URL, logger);

try {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  logger.info("database connected");
} catch (err) {
  logger.fatal({ err }, "database connection failed on startup");
  process.exit(1);
}

let boss: Awaited<ReturnType<typeof startBoss>>;
try {
  boss = await startBoss({ databaseUrl: env.DATABASE_URL, logger, role: "worker" });
} catch (err) {
  logger.fatal({ err }, "job queue (pg-boss) failed to start");
  process.exit(1);
}

// Outbox towards n8n (phase 6): "message.ready" + its delivery job, in the transaction
// that makes each message ready (5 places: ingest, media stored/final, transcription,
// conversion).
const emitMessageReadyInTx = createEmitMessageReadyInTx(createEnqueueN8nDeliveryInTx(boss));
const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
// Bot / human mode (phase 7): WhatsApp Business app echoes take over in the same transaction.
const conversationModeRepository = createConversationModeRepository(prisma, {
  scheduleBotResumeInTx: createScheduleBotResumeInTx(boss),
});
const ingestRepository = createWhatsAppIngestRepository(prisma, {
  enqueueMediaInTx: createEnqueueMediaInTx(boss),
  emitMessageReadyInTx,
  onHumanMessageInTx: createOnHumanMessageInTx({
    repository: conversationModeRepository,
    settings,
    logger,
  }),
});
await registerWhatsAppWebhookWorkers(boss, {
  ingest: createWhatsAppIngestService({
    repository: ingestRepository,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  }),
  repository: ingestRepository,
  sweeper: createWebhookSweeper({
    repository: createWhatsAppWebhookRepository(prisma),
    queue: createPgBossWebhookQueue(boss),
  }),
  logger,
  concurrency: env.WORKER_CONCURRENCY,
});
const graph = {
  baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
  version: env.WHATSAPP_GRAPH_API_VERSION,
  accessToken: env.WHATSAPP_ACCESS_TOKEN,
  timeoutMs: env.WHATSAPP_API_TIMEOUT_MS,
};

const mediaStorage = createPostgresMediaStorage(prisma);
// Media stored → in the same transaction: audio → pending transcription + job (phase 4);
// spreadsheet/CSV/text/Word → pending conversion + job (phase 5 M3a).
const mediaRepository = createMediaRepository(prisma, {
  emitMessageReadyInTx,
  onStoredInTx: composeOnStoredInTx(
    createOnReadyMediaStoredInTx(emitMessageReadyInTx),
    createOnAudioStoredInTx({ enqueueTranscriptionInTx: createEnqueueTranscriptionInTx(boss) }),
    createOnDocumentStoredInTx({
      enqueueConversionInTx: createEnqueueDocumentConversionInTx(boss),
    }),
  ),
});
await registerWhatsAppMediaWorkers(boss, {
  service: createMediaDownloadService({
    repository: mediaRepository,
    storage: mediaStorage,
    client: createWhatsAppMediaClient({
      graph,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      downloadTimeoutMs: env.MEDIA_DOWNLOAD_TIMEOUT_MS,
      production: env.NODE_ENV === "production",
    }),
    maxBytes: env.MEDIA_MAX_BYTES,
  }),
  repository: mediaRepository,
  logger,
  concurrency: env.MEDIA_WORKER_CONCURRENCY,
});
const outboundRepository = createOutboundRepository(prisma, {
  enqueueOutboundInTx: createEnqueueOutboundInTx(boss),
});
const outboundService = createOutboundService({
  repository: outboundRepository,
  client: createWhatsAppSendClient({ graph, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
});
await registerWhatsAppOutboundWorkers(boss, {
  service: outboundService,
  repository: outboundRepository,
  logger,
  concurrency: env.OUTBOUND_WORKER_CONCURRENCY,
});

const transcriber = createTranscriber(env);
const transcriptionRepository = createTranscriptionRepository(prisma, { emitMessageReadyInTx });
await registerMediaTranscriptionWorkers(boss, {
  service: createTranscriptionService({
    repository: transcriptionRepository,
    storage: mediaStorage,
    transcriber,
    language: env.TRANSCRIPTION_LANGUAGE,
    prompt: loadVocabularyPrompt(),
    dailyLimitPerContact: env.TRANSCRIPTION_DAILY_LIMIT_PER_CONTACT,
    maxAutoDurationSeconds: async () =>
      (await settings.getAll(logger))["transcription.maxAutoDurationSeconds"] as number,
  }),
  repository: transcriptionRepository,
  logger,
  concurrency: env.TRANSCRIPTION_WORKER_CONCURRENCY,
});

const conversionRepository = createDocumentConversionRepository(prisma, { emitMessageReadyInTx });
await registerDocumentConversionWorkers(boss, {
  service: createDocumentConversionService({
    repository: conversionRepository,
    storage: mediaStorage,
    converter: createIsolatedDocumentConverter({
      ...DEFAULT_CONVERSION_LIMITS,
      maxBytes: env.DOC_CONVERT_MAX_BYTES,
      maxSheets: env.DOC_CONVERT_MAX_SHEETS,
      maxRowsPerSheet: env.DOC_CONVERT_MAX_ROWS,
      maxColumns: env.DOC_CONVERT_MAX_COLUMNS,
      maxChars: env.DOC_CONVERT_MAX_CHARS,
      timeoutMs: env.DOC_CONVERT_TIMEOUT_MS,
    }),
  }),
  repository: conversionRepository,
  logger,
  concurrency: env.DOC_CONVERT_WORKER_CONCURRENCY,
});

// Bot / human mode (phase 7): reactivation at humanUntil + sweeper for lost jobs.
await registerConversationModeWorkers(boss, {
  service: createConversationModeService({ repository: conversationModeRepository, settings }),
  logger,
});

// Notification digests (phase 6): sent at the end of their window, anti-spam rules.
await registerNotificationDigestWorkers(boss, {
  service: createNotificationService({
    repository: createNotificationRepository(prisma, {
      scheduleDigestInTx: createScheduleDigestInTx(boss),
    }),
    settings,
    outbound: outboundService,
  }),
  logger,
});

// Delivery to n8n (off → events accumulate and go out once enabled).
if (env.N8N_DELIVERY_ENABLED) {
  const integrationRepository = createIntegrationEventRepository(prisma);
  await registerN8nDeliveryWorkers(boss, {
    service: createN8nDeliveryService({
      repository: integrationRepository,
      client: createN8nClient({
        url: env.N8N_RECEIVER_WEBHOOK_URL,
        secret: env.N8N_WEBHOOK_SECRET ?? "",
      }),
    }),
    repository: integrationRepository,
    watchdog: createN8nWatchdog({
      repository: integrationRepository,
      enqueue: (eventId) => enqueueN8nDelivery(boss, eventId),
    }),
    logger,
  });
}

logger.info(
  {
    n8nDelivery: env.N8N_DELIVERY_ENABLED,
    transcriptionProvider: transcriber.provider,
    transcriptionModel: transcriber.model,
    concurrency: env.WORKER_CONCURRENCY,
    mediaConcurrency: env.MEDIA_WORKER_CONCURRENCY,
    outboundConcurrency: env.OUTBOUND_WORKER_CONCURRENCY,
    graphBaseUrl: env.WHATSAPP_GRAPH_BASE_URL,
  },
  "worker started",
);

let shuttingDown = false;

function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, "worker shutting down");

  setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  boss
    .stop({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS })
    .catch((err: unknown) => logger.error({ err }, "error stopping pg-boss"))
    .then(() => prisma.$disconnect())
    .catch((err: unknown) => logger.error({ err }, "error disconnecting prisma"))
    .finally(() => process.exit(exitCode));
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
