import { createHash } from "node:crypto";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { WebhookQueue } from "../../jobs/queues.js";
import type { WhatsAppWebhookRepository } from "./whatsapp-webhook.repository.js";
import { isValidWhatsAppSignature, safeEqual } from "./whatsapp-signature.js";

export interface WhatsAppWebhookService {
  /** GET verification handshake. Returns hub.challenge or throws 403. */
  verifySubscription(query: { mode: string; token: string; challenge: string }): string;
  /**
   * POST delivery: verify signature over the RAW body (401 if invalid), parse, store
   * (dedupe by body hash), enqueue. Never processes inline: Meta expects a quick 200.
   */
  receive(input: {
    rawBody: Buffer;
    signature: string | undefined;
    log: Logger;
  }): Promise<{ eventId?: string; duplicate: boolean; enqueued: boolean }>;
}

export function createWhatsAppWebhookService(deps: {
  repository: WhatsAppWebhookRepository;
  queue: WebhookQueue;
  appSecret: string;
  verifyToken: string;
}): WhatsAppWebhookService {
  return {
    verifySubscription({ mode, token, challenge }) {
      if (mode !== "subscribe" || !safeEqual(token, deps.verifyToken)) {
        throw errors.forbidden("Webhook verification failed");
      }
      return challenge;
    },

    async receive({ rawBody, signature, log }) {
      if (!isValidWhatsAppSignature(rawBody, signature, deps.appSecret)) {
        log.warn(
          { signaturePresent: signature !== undefined, bodyBytes: rawBody.length },
          "whatsapp webhook rejected: invalid signature",
        );
        throw errors.unauthorized("Invalid webhook signature");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw errors.badRequest("Webhook body is not valid JSON");
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw errors.badRequest("Webhook body must be a JSON object");
      }

      const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
      const saved = await deps.repository.saveEvent({ bodySha256, payload });

      if (saved.duplicate) {
        // If the original was never enqueued, the sweeper picks it up.
        log.info({ bodySha256 }, "whatsapp webhook duplicate delivery ignored");
        return { duplicate: true, enqueued: false };
      }

      // The stored event is the source of truth (outbox): if enqueueing fails we still
      // ack 200 and the sweeper re-enqueues it. A 5xx would make Meta re-deliver an
      // identical body, which would be deduped — and the event would be lost.
      try {
        await deps.queue.enqueueWebhookEvent(saved.id);
        await deps.repository.markEnqueued(saved.id);
      } catch (err) {
        log.error({ err, eventId: saved.id }, "enqueue failed; the sweeper will retry");
        return { eventId: saved.id, duplicate: false, enqueued: false };
      }

      log.info({ eventId: saved.id }, "whatsapp webhook stored and enqueued");
      return { eventId: saved.id, duplicate: false, enqueued: true };
    },
  };
}
