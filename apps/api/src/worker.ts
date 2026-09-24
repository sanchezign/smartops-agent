import { createPrismaClient } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import { createEnqueueMediaInTx, createPgBossWebhookQueue, startBoss } from "./jobs/boss.js";
import { registerWhatsAppMediaWorkers } from "./jobs/whatsapp-media.job.js";
import { registerWhatsAppWebhookWorkers } from "./jobs/whatsapp-webhook.job.js";
import { createPostgresMediaStorage } from "./modules/media/media-storage.js";
import { createMediaRepository } from "./modules/media/media.repository.js";
import { createMediaDownloadService } from "./modules/media/media.service.js";
import { createWebhookSweeper } from "./modules/whatsapp/webhook-sweeper.js";
import { createWhatsAppMediaClient } from "./modules/whatsapp/whatsapp-media.client.js";
import { createWhatsAppIngestRepository } from "./modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "./modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppWebhookRepository } from "./modules/whatsapp/whatsapp-webhook.repository.js";

/**
 * Worker process: consumes pg-boss queues (webhook processing, media downloads, dead
 * letters, sweeper).
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

const ingestRepository = createWhatsAppIngestRepository(prisma, {
  enqueueMediaInTx: createEnqueueMediaInTx(boss),
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
const mediaRepository = createMediaRepository(prisma);
await registerWhatsAppMediaWorkers(boss, {
  service: createMediaDownloadService({
    repository: mediaRepository,
    storage: createPostgresMediaStorage(prisma),
    client: createWhatsAppMediaClient({
      graph: {
        baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
        version: env.WHATSAPP_GRAPH_API_VERSION,
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        timeoutMs: env.WHATSAPP_API_TIMEOUT_MS,
      },
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
logger.info(
  {
    concurrency: env.WORKER_CONCURRENCY,
    mediaConcurrency: env.MEDIA_WORKER_CONCURRENCY,
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
