import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { OutboundRepository } from "../modules/messaging/outbound.repository.js";
import type { OutboundService } from "../modules/messaging/outbound.service.js";
import { QUEUES, type OutboundMessageJob } from "./queues.js";

/**
 * Registers the outbound workers:
 * - whatsapp-outbound (key_strict_fifo by conversation): send one message. Transient
 *   errors throw → retry; the FINAL attempt settles the message as failed without
 *   throwing, so no failed job keeps blocking the conversation.
 * - whatsapp-outbound-dlq: safety net (e.g. the worker died on the last attempt): marks
 *   the message failed and DELETES the failed source job to unblock the conversation.
 */
export async function registerWhatsAppOutboundWorkers(
  boss: PgBoss,
  deps: {
    service: OutboundService;
    repository: Pick<OutboundRepository, "markFailed">;
    logger: Logger;
    concurrency: number;
  },
): Promise<void> {
  await boss.work(
    QUEUES.whatsappOutbound,
    { includeMetadata: true, localConcurrency: deps.concurrency },
    async ([job]: JobWithMetadata<OutboundMessageJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        messageId: job.data.messageId,
        conversationId: job.singletonKey,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      const result = await deps.service.processOutbound(job.data.messageId, log, {
        finalAttempt: job.retryCount >= job.retryLimit,
      });
      log.debug(result, "outbound job handled");
    },
  );

  await boss.work(
    QUEUES.whatsappOutboundDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<OutboundMessageJob>[]) => {
      if (!job) return;
      await deps.repository.markFailed(
        job.data.messageId,
        "retries_exhausted",
        "Outbound job dead-lettered",
      );
      if (job.sourceName && job.sourceId) {
        // A failed job would hold back every later message of this conversation.
        await boss.deleteJob(job.sourceName, job.sourceId);
      }
      deps.logger.error(
        {
          jobId: job.id,
          messageId: job.data.messageId,
          conversationId: job.singletonKey,
          sourceJobId: job.sourceId,
        },
        "outbound message permanently failed (dead letter); conversation unblocked",
      );
    },
  );
}
