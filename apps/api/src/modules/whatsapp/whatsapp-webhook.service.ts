import { createHash } from "node:crypto";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { WhatsAppWebhookRepository } from "./whatsapp-webhook.repository.js";
import { isValidWhatsAppSignature, safeEqual } from "./whatsapp-signature.js";
import { summarizeWhatsAppWebhook, type WebhookSummaryItem } from "./whatsapp-webhook.summary.js";

export interface WhatsAppWebhookService {
  /** GET verification handshake. Returns hub.challenge or throws 403. */
  verifySubscription(query: { mode: string; token: string; challenge: string }): string;
  /**
   * POST delivery: verify signature over the RAW body (401 if invalid), parse, store
   * (dedupe by body hash). Must stay fast: Meta expects a quick 200.
   */
  receive(input: {
    rawBody: Buffer;
    signature: string | undefined;
    log: Logger;
  }): Promise<{ eventId?: string; duplicate: boolean }>;
}

export function createWhatsAppWebhookService(deps: {
  repository: WhatsAppWebhookRepository;
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
        log.info({ bodySha256 }, "whatsapp webhook duplicate delivery ignored");
        return { duplicate: true };
      }

      // Milestone 1 (diagnostics): log-safe summary of what arrived. Processing is
      // NOT done here — milestone 2 moves it to the pg-boss worker.
      logSummary(log, saved.id, summarizeWhatsAppWebhook(payload));
      return { eventId: saved.id, duplicate: false };
    },
  };
}

function logSummary(
  log: Logger,
  eventId: string,
  summary: ReturnType<typeof summarizeWhatsAppWebhook>,
): void {
  if (!summary.recognized) {
    log.warn({ eventId }, "whatsapp webhook stored but payload shape not recognized");
    return;
  }
  if (summary.items.length === 0) {
    log.info({ eventId, object: summary.object }, "whatsapp webhook stored (no items)");
    return;
  }
  for (const item of summary.items) {
    logItem(log, eventId, item);
  }
}

function logItem(log: Logger, eventId: string, item: WebhookSummaryItem): void {
  switch (item.kind) {
    case "status":
      if (item.status === "failed" || item.errors.length > 0) {
        log.warn({ eventId, ...item }, "whatsapp status: failed");
      } else {
        log.info({ eventId, ...item }, `whatsapp status: ${item.status}`);
      }
      return;
    case "message":
      log.info({ eventId, ...item }, "whatsapp inbound message");
      return;
    case "error":
      log.warn({ eventId, field: item.field, errors: item.errors }, "whatsapp webhook errors");
      return;
    case "other_field":
      log.info({ eventId, field: item.field }, "whatsapp webhook for another field");
      return;
  }
}
