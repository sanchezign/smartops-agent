import type { Logger } from "../../common/logger.js";
import { maskPhone, maskUserId } from "../../common/phone.js";
import { planMedia } from "../media/media-policy.js";
import type { MediaIngestPlan, WhatsAppIngestRepository } from "./whatsapp-ingest.repository.js";
import { parseWhatsAppWebhook, type ParsedInboundMessage } from "./whatsapp-webhook.parser.js";
import { summarizeParsedWebhook, toSummaryErrors } from "./whatsapp-webhook.summary.js";

/**
 * Processes one stored WebhookEvent (called by the pg-boss worker). Idempotent: an
 * event that is no longer `received` is skipped, and messages/statuses are deduped
 * by the repository. Throwing makes pg-boss retry the job with backoff.
 */

export interface InboundMessageContext {
  messageId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInboundMessage;
  log: Logger;
}

/** Extension point: phase 7 (HUMAN mode check) and phase 6 (forward to n8n). */
export type InboundMessageHook = (ctx: InboundMessageContext) => Promise<void>;

export interface ProcessEventResult {
  outcome: "processed" | "ignored" | "skipped" | "not_found";
  messagesCreated: number;
  duplicateMessages: number;
  statusesRecorded: number;
  duplicateStatuses: number;
  /** Coexistence echoes (phase 7): messages people sent from the WhatsApp Business app. */
  echoesStored: number;
  skippedItems: number;
}

/** Fields we process: incoming messages/statuses and coexistence echoes (phase 7). */
const HANDLED_FIELDS = new Set(["messages", "smb_message_echoes", "user_preferences"]);

export interface WhatsAppIngestService {
  processEvent(eventId: string, log: Logger): Promise<ProcessEventResult>;
}

/** Media policy at ingest time: skipped/rejected media never gets a download job. */
function toMediaIngestPlan(message: ParsedInboundMessage): MediaIngestPlan {
  const plan = planMedia(message.waType, message.media?.mimeType);
  if (plan.action === "download") return { status: "pending" };
  return { status: plan.action === "skip" ? "skipped" : "rejected", rejectReason: plan.reason };
}

/** Default hook until phases 6/7: log only — no bot action yet. */
export const logOnlyInboundHook: InboundMessageHook = async ({ log, messageId }) => {
  log.debug({ messageId }, "inbound handoff pending (n8n: phase 6, human mode: phase 7)");
};

export function createWhatsAppIngestService(deps: {
  repository: WhatsAppIngestRepository;
  /** Our business number. Changes for other numbers (e.g. Meta dashboard tests) are ignored. */
  phoneNumberId: string;
  onInboundMessage?: InboundMessageHook;
}): WhatsAppIngestService {
  const onInbound = deps.onInboundMessage ?? logOnlyInboundHook;

  return {
    async processEvent(eventId, log) {
      const result: ProcessEventResult = {
        outcome: "processed",
        messagesCreated: 0,
        duplicateMessages: 0,
        statusesRecorded: 0,
        duplicateStatuses: 0,
        echoesStored: 0,
        skippedItems: 0,
      };

      const event = await deps.repository.getEvent(eventId);
      if (!event) {
        log.warn({ eventId }, "webhook event not found (deleted?)");
        return { ...result, outcome: "not_found" };
      }
      if (event.status !== "received") {
        log.debug({ eventId, status: event.status }, "webhook event already handled, skipping");
        return { ...result, outcome: "skipped" };
      }
      await deps.repository.incrementAttempts(eventId);

      const parsed = parseWhatsAppWebhook(event.payload);
      if (!parsed.recognized) {
        log.warn({ eventId }, "webhook payload not recognized as WhatsApp");
        await deps.repository.finishEvent(eventId, "ignored", "unrecognized payload");
        return { ...result, outcome: "ignored" };
      }

      // Diagnostics (masked): every status with its Meta error codes, every message type.
      for (const item of summarizeParsedWebhook(parsed).items) {
        if (item.kind === "status" && (item.status === "failed" || item.errors.length > 0)) {
          log.warn({ eventId, ...item }, "whatsapp status: failed");
        } else if (item.kind === "error" || item.kind === "invalid_items") {
          log.warn({ eventId, ...item }, `whatsapp webhook ${item.kind}`);
        }
      }

      const ours = parsed.changes.filter(
        (c) => HANDLED_FIELDS.has(c.field) && c.phoneNumberId === deps.phoneNumberId,
      );
      const ignored = parsed.changes.filter((c) => !ours.includes(c));
      for (const change of ignored) {
        log.info(
          { eventId, field: change.field, phoneNumberId: change.phoneNumberId },
          HANDLED_FIELDS.has(change.field)
            ? "ignoring change for another phone_number_id (e.g. dashboard test)"
            : "ignoring webhook field not handled yet",
        );
      }
      if (ours.length === 0) {
        await deps.repository.finishEvent(
          eventId,
          "ignored",
          "no messages change for this phone_number_id",
        );
        return { ...result, outcome: "ignored" };
      }

      for (const change of ours) {
        result.skippedItems += change.invalidItems.length;

        for (const status of change.statuses) {
          const recorded = await deps.repository.recordStatus({ status, webhookEventId: eventId });
          if (recorded.duplicate) result.duplicateStatuses += 1;
          else result.statusesRecorded += 1;
          log.info(
            {
              eventId,
              wamid: status.waMessageId,
              status: status.status,
              recipient: maskPhone(status.recipientWaId),
              ...(status.recipientUserId
                ? { recipientUserId: maskUserId(status.recipientUserId) }
                : {}),
              messageId: recorded.messageId,
              messageUpdated: recorded.messageUpdated,
              duplicate: recorded.duplicate,
              ...(status.errors.length > 0 ? { errors: toSummaryErrors(status.errors) } : {}),
            },
            `whatsapp status: ${status.status}`,
          );
        }

        for (const preference of change.userPreferences) {
          await deps.repository.recordUserPreference(preference);
          log.info(
            {
              eventId,
              to: maskPhone(preference.waId),
              category: preference.category,
              value: preference.value,
            },
            "whatsapp user_preferences (marketing, informational)",
          );
        }

        for (const echo of change.echoes) {
          if (!echo.toWaId && !echo.toUserId) {
            result.skippedItems += 1;
            log.warn({ eventId, wamid: echo.waMessageId }, "echo without recipient, skipped");
            continue;
          }
          const stored = await deps.repository.ingestEcho({ echo, webhookEventId: eventId });
          if (stored.outcome === "created") result.echoesStored += 1;
          log.info(
            {
              eventId,
              wamid: echo.waMessageId,
              kind: echo.kind,
              type: echo.waType,
              to: echo.toWaId ? maskPhone(echo.toWaId) : maskUserId(echo.toUserId),
              outcome: stored.outcome,
              ...(stored.outcome === "created"
                ? {
                    messageId: stored.messageId,
                    conversationId: stored.conversationId,
                    mode: stored.takeover?.state.mode,
                    humanUntil: stored.takeover?.state.humanUntil,
                    canceledMessages: stored.takeover?.canceledMessages,
                  }
                : {}),
            },
            "whatsapp business app echo",
          );
        }

        for (const message of change.messages) {
          if (!message.fromWaId && !message.fromUserId) {
            result.skippedItems += 1;
            log.warn(
              { eventId, wamid: message.waMessageId },
              "inbound message without wa_id or BSUID, skipped",
            );
            continue;
          }

          const ingested = await deps.repository.ingestInboundMessage({
            message,
            webhookEventId: eventId,
            ...(message.media ? { mediaPlan: toMediaIngestPlan(message) } : {}),
          });
          if (ingested.outcome === "duplicate") {
            result.duplicateMessages += 1;
            log.debug({ eventId, wamid: message.waMessageId }, "duplicate message ignored");
            continue;
          }

          result.messagesCreated += 1;
          if (ingested.conflict) {
            log.warn(
              { eventId, wamid: message.waMessageId, ...ingested.conflict },
              "contact identity conflict: phone and BSUID belong to different contacts (not merged)",
            );
          }
          log.info(
            {
              eventId,
              wamid: message.waMessageId,
              type: message.waType,
              from: maskPhone(message.fromWaId),
              ...(message.fromUserId ? { fromUserId: maskUserId(message.fromUserId) } : {}),
              messageId: ingested.messageId,
              conversationId: ingested.conversationId,
              hasMedia: message.media !== null,
            },
            "whatsapp inbound message stored",
          );
          await onInbound({
            messageId: ingested.messageId,
            contactId: ingested.contactId,
            conversationId: ingested.conversationId,
            message,
            log,
          });
        }
      }

      await deps.repository.finishEvent(eventId, "processed");
      return result;
    },
  };
}
