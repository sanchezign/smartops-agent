import type { Queue } from "pg-boss";

/**
 * Queue names and options (pg-boss 12). Names may only contain [A-Za-z0-9_.\-/].
 * A dead letter queue must exist before a queue references it → order matters.
 */
export const QUEUES = {
  whatsappWebhook: "whatsapp-webhook",
  whatsappWebhookDlq: "whatsapp-webhook-dlq",
  webhookSweeper: "webhook-sweeper",
} as const;

export interface WebhookEventJob {
  eventId: string;
}

type QueueDefinition = Omit<Queue, "name"> & { name: string };

/** In creation order (DLQ before the queue that references it). */
export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: QUEUES.whatsappWebhookDlq,
    // Dead-lettered jobs are handled once (mark event failed + log); keep them 30 days.
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.whatsappWebhook,
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 60,
    deadLetter: QUEUES.whatsappWebhookDlq,
  },
  {
    name: QUEUES.webhookSweeper,
    // Runs every minute; a failed run is simply replaced by the next one.
    retryLimit: 0,
    expireInSeconds: 60,
    deleteAfterSeconds: 3600,
  },
];

/** What the API needs from the queue (injected → e2e tests use a fake). */
export interface WebhookQueue {
  enqueueWebhookEvent(eventId: string): Promise<void>;
}
