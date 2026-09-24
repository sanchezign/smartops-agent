import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { WhatsAppIngestRepository } from "../modules/whatsapp/whatsapp-ingest.repository.js";
import type { WhatsAppIngestService } from "../modules/whatsapp/whatsapp-ingest.service.js";
import type { createWebhookSweeper } from "../modules/whatsapp/webhook-sweeper.js";
import { QUEUES, type WebhookEventJob } from "./queues.js";

/** Cron for the outbox sweeper (every minute). */
const SWEEPER_CRON = "* * * * *";

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Registers the webhook workers:
 * - whatsapp-webhook: process one WebhookEvent (retries with backoff on throw).
 * - whatsapp-webhook-dlq: retries exhausted → mark the event failed + log error.
 * - webhook-sweeper (cron): re-enqueue stored events that were never enqueued.
 */
export async function registerWhatsAppWebhookWorkers(
  boss: PgBoss,
  deps: {
    ingest: WhatsAppIngestService;
    repository: Pick<WhatsAppIngestRepository, "recordEventError" | "markEventFailed">;
    sweeper: ReturnType<typeof createWebhookSweeper>;
    logger: Logger;
    concurrency: number;
  },
): Promise<void> {
  await boss.work(
    QUEUES.whatsappWebhook,
    { includeMetadata: true, localConcurrency: deps.concurrency },
    async ([job]: JobWithMetadata<WebhookEventJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        eventId: job.data.eventId,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      try {
        const result = await deps.ingest.processEvent(job.data.eventId, log);
        log.info(result, "webhook event handled");
      } catch (err) {
        log.error({ err }, "webhook event processing failed (will retry)");
        await deps.repository
          .recordEventError(job.data.eventId, errorMessage(err))
          .catch((recordErr: unknown) => log.error({ err: recordErr }, "could not record error"));
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.whatsappWebhookDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<WebhookEventJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({ jobId: job.id, eventId: job.data.eventId });
      await deps.repository.markEventFailed(
        job.data.eventId,
        `retries exhausted on ${job.sourceName ?? QUEUES.whatsappWebhook}`,
      );
      log.error(
        { sourceQueue: job.sourceName },
        "webhook event permanently failed (dead letter): see webhook_events.error",
      );
    },
  );

  await boss.schedule(QUEUES.webhookSweeper, SWEEPER_CRON);
  await boss.work(QUEUES.webhookSweeper, async () => {
    await deps.sweeper.run(deps.logger.child({ job: QUEUES.webhookSweeper }));
  });
}
