import { fromPrisma, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ScheduleBotResumeInTx } from "../modules/conversations/conversation-mode.repository.js";
import type { EnqueueOutboundInTx } from "../modules/messaging/outbound.repository.js";
import type { EnqueueMediaInTx } from "../modules/whatsapp/whatsapp-ingest.repository.js";
import {
  QUEUE_DEFINITIONS,
  QUEUES,
  type ConversationBotResumeJob,
  type MediaDownloadJob,
  type OutboundMessageJob,
  type DocumentConversionJob,
  type N8nDeliveryJob,
  type NotificationDigestJob,
  type TranscriptionJob,
  type WebhookEventJob,
  type WebhookQueue,
} from "./queues.js";

const BOSS_SCHEMA = "pgboss";
/** Small pools: API and worker each hold their own (Render Postgres has connection limits). */
const BOSS_POOL_MAX = 5;

/**
 * Starts pg-boss in the same database (schema `pgboss`, created/migrated by pg-boss).
 * - api: only sends jobs (no maintenance, no cron scheduling).
 * - worker: runs workers, maintenance/supervision and cron schedules.
 */
export async function startBoss(options: {
  databaseUrl: string;
  logger: Logger;
  role: "api" | "worker";
}): Promise<PgBoss> {
  const isWorker = options.role === "worker";
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: BOSS_SCHEMA,
    max: BOSS_POOL_MAX,
    application_name: `smartops-${options.role}`,
    supervise: isWorker,
    schedule: isWorker,
  });

  boss.on("error", (err) => options.logger.error({ err }, "pg-boss error"));
  boss.on("warning", (warning) => options.logger.warn({ warning }, "pg-boss warning"));

  await boss.start();
  await ensureQueues(boss);
  return boss;
}

/** Idempotent: creates missing queues and syncs options of existing ones. */
async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const { name, policy, partition, ...options } of QUEUE_DEFINITIONS) {
    if (await boss.getQueue(name)) {
      await boss.updateQueue(name, options);
    } else {
      await boss.createQueue(name, {
        ...options,
        ...(policy ? { policy } : {}),
        ...(partition ? { partition } : {}),
      });
    }
  }
}

export function createPgBossWebhookQueue(boss: PgBoss): WebhookQueue {
  return {
    async enqueueWebhookEvent(eventId) {
      const data: WebhookEventJob = { eventId };
      const jobId = await boss.send(QUEUES.whatsappWebhook, data);
      if (!jobId) throw new Error(`pg-boss did not create a job for webhook event ${eventId}`);
    },
  };
}

/** Enqueues a media download inside the caller's Prisma transaction (atomic with the message). */
export function createEnqueueMediaInTx(boss: PgBoss): EnqueueMediaInTx {
  return async (tx, mediaFileId) => {
    const data: MediaDownloadJob = { mediaFileId };
    const jobId = await boss.send(QUEUES.whatsappMedia, data, { db: fromPrisma(tx) });
    if (!jobId) throw new Error(`pg-boss did not create a media job for ${mediaFileId}`);
  };
}

/** Enqueues a media download outside a transaction (manual retries). */
export async function enqueueMediaDownload(boss: PgBoss, mediaFileId: string): Promise<void> {
  const data: MediaDownloadJob = { mediaFileId };
  const jobId = await boss.send(QUEUES.whatsappMedia, data);
  if (!jobId) throw new Error(`pg-boss did not create a media job for ${mediaFileId}`);
}

/**
 * Enqueues an outbound send inside the caller's Prisma transaction, keyed by
 * conversation (key_strict_fifo → strict order per conversation).
 */
export function createEnqueueOutboundInTx(boss: PgBoss): EnqueueOutboundInTx {
  return async (tx, { messageId, conversationId }) => {
    const data: OutboundMessageJob = { messageId };
    const jobId = await boss.send(QUEUES.whatsappOutbound, data, {
      db: fromPrisma(tx),
      singletonKey: conversationId,
    });
    if (!jobId) throw new Error(`pg-boss did not create an outbound job for ${messageId}`);
  };
}

/** Enqueues a transcription inside the caller's Prisma transaction (atomic with media stored). */
export function createEnqueueTranscriptionInTx(
  boss: PgBoss,
): (tx: Prisma.TransactionClient, mediaFileId: string) => Promise<void> {
  return async (tx, mediaFileId) => {
    const data: TranscriptionJob = { mediaFileId };
    const jobId = await boss.send(QUEUES.mediaTranscription, data, { db: fromPrisma(tx) });
    if (!jobId) throw new Error(`pg-boss did not create a transcription job for ${mediaFileId}`);
  };
}

/** Enqueues a document conversion inside the caller's Prisma transaction (media stored). */
export function createEnqueueDocumentConversionInTx(
  boss: PgBoss,
): (tx: Prisma.TransactionClient, mediaFileId: string) => Promise<void> {
  return async (tx, mediaFileId) => {
    const data: DocumentConversionJob = { mediaFileId };
    const jobId = await boss.send(QUEUES.documentConversion, data, { db: fromPrisma(tx) });
    if (!jobId) throw new Error(`pg-boss did not create a conversion job for ${mediaFileId}`);
  };
}

/** Enqueues an n8n delivery inside the caller's transaction (atomic with the outbox row). */
export function createEnqueueN8nDeliveryInTx(
  boss: PgBoss,
): (tx: Prisma.TransactionClient, eventId: string) => Promise<void> {
  return async (tx, eventId) => {
    const data: N8nDeliveryJob = { eventId };
    const jobId = await boss.send(QUEUES.n8nDelivery, data, { db: fromPrisma(tx) });
    if (!jobId) throw new Error(`pg-boss did not create an n8n delivery job for ${eventId}`);
  };
}

/** Schedules a notification digest at the end of its window, inside the caller's transaction. */
export function createScheduleDigestInTx(
  boss: PgBoss,
): (tx: Prisma.TransactionClient, digestId: string, startAfter: Date) => Promise<void> {
  return async (tx, digestId, startAfter) => {
    const data: NotificationDigestJob = { digestId };
    const jobId = await boss.send(QUEUES.notificationDigest, data, {
      db: fromPrisma(tx),
      startAfter,
    });
    if (!jobId) throw new Error(`pg-boss did not create a digest job for ${digestId}`);
  };
}

/** Schedules the bot reactivation (humanUntil) inside the mode-change transaction (phase 7). */
export function createScheduleBotResumeInTx(boss: PgBoss): ScheduleBotResumeInTx {
  return async (tx, { conversationId, at }) => {
    const data: ConversationBotResumeJob = { conversationId };
    const jobId = await boss.send(QUEUES.conversationBotResume, data, {
      db: fromPrisma(tx),
      startAfter: at,
    });
    if (!jobId) throw new Error(`pg-boss did not create a resume job for ${conversationId}`);
  };
}

/** Enqueues an n8n delivery outside a transaction (watchdog, replay). */
export async function enqueueN8nDelivery(boss: PgBoss, eventId: string): Promise<void> {
  const data: N8nDeliveryJob = { eventId };
  const jobId = await boss.send(QUEUES.n8nDelivery, data);
  if (!jobId) throw new Error(`pg-boss did not create an n8n delivery job for ${eventId}`);
}

/** Enqueues a transcription outside a transaction (manual retries). */
export async function enqueueTranscription(boss: PgBoss, mediaFileId: string): Promise<void> {
  const data: TranscriptionJob = { mediaFileId };
  const jobId = await boss.send(QUEUES.mediaTranscription, data);
  if (!jobId) throw new Error(`pg-boss did not create a transcription job for ${mediaFileId}`);
}
