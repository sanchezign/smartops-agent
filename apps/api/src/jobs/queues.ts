import type { Queue } from "pg-boss";

/**
 * Queue names and options (pg-boss 12). Names may only contain [A-Za-z0-9_.\-/].
 * A dead letter queue must exist before a queue references it → order matters.
 */
export const QUEUES = {
  whatsappWebhook: "whatsapp-webhook",
  whatsappWebhookDlq: "whatsapp-webhook-dlq",
  webhookSweeper: "webhook-sweeper",
  whatsappMedia: "whatsapp-media",
  whatsappMediaDlq: "whatsapp-media-dlq",
  whatsappOutbound: "whatsapp-outbound",
  whatsappOutboundDlq: "whatsapp-outbound-dlq",
  mediaTranscription: "media-transcription",
  mediaTranscriptionDlq: "media-transcription-dlq",
  documentConversion: "document-conversion",
  documentConversionDlq: "document-conversion-dlq",
  n8nDelivery: "n8n-delivery",
  n8nDeliveryDlq: "n8n-delivery-dlq",
  n8nWatchdog: "n8n-watchdog",
  notificationDigest: "notification-digest",
  notificationDigestDlq: "notification-digest-dlq",
  conversationBotResume: "conversation-bot-resume",
  conversationModeSweeper: "conversation-mode-sweeper",
} as const;

export interface WebhookEventJob {
  eventId: string;
}

export interface MediaDownloadJob {
  mediaFileId: string;
}

export interface OutboundMessageJob {
  messageId: string;
}

export interface TranscriptionJob {
  mediaFileId: string;
}

export interface DocumentConversionJob {
  mediaFileId: string;
}

export interface N8nDeliveryJob {
  eventId: string;
}

export interface NotificationDigestJob {
  digestId: string;
}

export interface ConversationBotResumeJob {
  conversationId: string;
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
    name: QUEUES.whatsappMediaDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.whatsappMedia,
    // Media ids live 7 days; backoff 20 s, capped at 10 min per retry, 6 retries → gives up
    // within ~30 min in total (e.g. token renewal) — verified in queue-definitions.test.ts
    // against pg-boss's own backoff formula (phase 10 fix: the previous 10 s/30 min-cap
    // combination never actually reached 30 min in total, only ~10.5–21 min).
    retryLimit: 6,
    retryDelay: 20,
    retryBackoff: true,
    retryDelayMax: 600,
    // Two Graph calls + a download of up to MEDIA_DOWNLOAD_TIMEOUT_MS.
    expireInSeconds: 180,
    deadLetter: QUEUES.whatsappMediaDlq,
  },
  {
    name: QUEUES.whatsappOutboundDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.whatsappOutbound,
    // Strict FIFO per singletonKey (= conversationId): messages to one contact go out in
    // order; different conversations run in parallel. A job in active/retry/failed
    // state holds back later jobs of the same conversation. The policy is fixed at
    // creation (updateQueue cannot change it).
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 60,
    deadLetter: QUEUES.whatsappOutboundDlq,
  },
  {
    name: QUEUES.mediaTranscriptionDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.mediaTranscription,
    // Groq free plan: 20 req/min → 429s are expected under bursts; back off 30 s → 15 min.
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    // Storage read + provider call (TRANSCRIPTION_TIMEOUT_MS, 60 s by default).
    expireInSeconds: 180,
    deadLetter: QUEUES.mediaTranscriptionDlq,
  },
  {
    name: QUEUES.documentConversionDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.documentConversion,
    // Rejections are permanent (no retry); only storage/DB errors are retried.
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    // Conversion runs in a worker thread killed at DOC_CONVERT_TIMEOUT_MS (20 s).
    expireInSeconds: 120,
    deadLetter: QUEUES.documentConversionDlq,
  },
  {
    name: QUEUES.n8nDeliveryDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.n8nDelivery,
    // ~24 h to survive a night-long n8n outage (user rule): 30 s doubling up to 1 h, then
    // hourly → 30 retries ≈ 24 h. Then the DLQ marks the event failed + alert (n8n:replay).
    retryLimit: 30,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 60,
    deadLetter: QUEUES.n8nDeliveryDlq,
  },
  {
    name: QUEUES.notificationDigestDlq,
    retryLimit: 3,
    retryDelay: 30,
    deleteAfterSeconds: 30 * 24 * 3600,
  },
  {
    name: QUEUES.notificationDigest,
    // Sent at the end of the digest window (startAfter); Meta/network errors retried.
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 60,
    deadLetter: QUEUES.notificationDigestDlq,
  },
  {
    name: QUEUES.conversationBotResume,
    // startAfter = humanUntil (phase 7). A stale job (the takeover was extended or resumed
    // by hand) is a no-op; the sweeper covers lost jobs, so a short retry is enough.
    retryLimit: 3,
    retryDelay: 30,
    expireInSeconds: 60,
    deleteAfterSeconds: 24 * 3600,
  },
  {
    name: QUEUES.conversationModeSweeper,
    retryLimit: 0,
    expireInSeconds: 60,
    deleteAfterSeconds: 3600,
  },
  {
    name: QUEUES.n8nWatchdog,
    retryLimit: 0,
    expireInSeconds: 120,
    deleteAfterSeconds: 3600,
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
