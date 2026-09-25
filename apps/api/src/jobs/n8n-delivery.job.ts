import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { IntegrationEventRepository } from "../modules/integration/integration-event.repository.js";
import type { N8nDeliveryService, createN8nWatchdog } from "../modules/integration/n8n-delivery.js";
import { QUEUES, type N8nDeliveryJob } from "./queues.js";

const WATCHDOG_CRON = "*/5 * * * *";

/**
 * Registers the n8n delivery workers (phase 6, ADR-015):
 * - n8n-delivery: POST one outbox event to the n8n receiver (throws → retry, ~24 h).
 * - n8n-delivery-dlq: retries exhausted → event failed + integration_error alert.
 * - n8n-watchdog (every 5 min): lost jobs and delivered-but-never-processed events.
 */
export async function registerN8nDeliveryWorkers(
  boss: PgBoss,
  deps: {
    service: N8nDeliveryService;
    repository: Pick<IntegrationEventRepository, "markFailed">;
    watchdog: ReturnType<typeof createN8nWatchdog>;
    logger: Logger;
  },
): Promise<void> {
  await boss.work(
    QUEUES.n8nDelivery,
    { includeMetadata: true, localConcurrency: 2 },
    async ([job]: JobWithMetadata<N8nDeliveryJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        eventId: job.data.eventId,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      await deps.service.deliver(job.data.eventId, log);
    },
  );

  await boss.work(
    QUEUES.n8nDeliveryDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<N8nDeliveryJob>[]) => {
      if (!job) return;
      const failed = await deps.repository.markFailed(
        job.data.eventId,
        "retries exhausted (~24 h): n8n unreachable or rejecting the event",
      );
      if (failed) {
        deps.logger.error(
          { jobId: job.id, eventId: job.data.eventId },
          "n8n delivery permanently failed: alert raised, resend with n8n:replay",
        );
      }
    },
  );

  await boss.schedule(QUEUES.n8nWatchdog, WATCHDOG_CRON);
  await boss.work(QUEUES.n8nWatchdog, async () => {
    await deps.watchdog.run(deps.logger.child({ job: QUEUES.n8nWatchdog }));
  });
}
