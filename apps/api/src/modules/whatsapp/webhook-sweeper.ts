import type { Logger } from "../../common/logger.js";
import type { WebhookQueue } from "../../jobs/queues.js";
import type { WhatsAppWebhookRepository } from "./whatsapp-webhook.repository.js";

/**
 * Safety net for the webhook outbox: re-enqueues `received` events that were stored
 * but never enqueued (pg-boss unavailable at receive time). Runs every minute in the
 * worker. Events younger than `graceMs` are left alone (the API may still be enqueueing).
 */
export function createWebhookSweeper(deps: {
  repository: Pick<WhatsAppWebhookRepository, "findUnenqueued" | "markEnqueued">;
  queue: WebhookQueue;
  graceMs?: number;
  batchSize?: number;
  now?: () => Date;
}) {
  const graceMs = deps.graceMs ?? 60_000;
  const batchSize = deps.batchSize ?? 100;
  const now = deps.now ?? (() => new Date());

  return {
    async run(log: Logger): Promise<number> {
      const ids = await deps.repository.findUnenqueued({
        receivedBefore: new Date(now().getTime() - graceMs),
        limit: batchSize,
      });
      for (const id of ids) {
        await deps.queue.enqueueWebhookEvent(id);
        await deps.repository.markEnqueued(id);
      }
      if (ids.length > 0) log.warn({ count: ids.length }, "sweeper re-enqueued webhook events");
      return ids.length;
    },
  };
}
