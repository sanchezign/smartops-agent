import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { maskPhone, maskUserId } from "../../common/phone.js";
import type { MessageAuthor, MessagePurpose } from "../../generated/prisma/enums.js";
import { customerServiceWindow } from "../whatsapp/customer-service-window.js";
import {
  buildSendPayload,
  WhatsAppSendError,
  type SendContent,
  type SendRecipient,
  type WhatsAppSendClient,
} from "../whatsapp/whatsapp-send.client.js";
import {
  idempotencyKeySchema,
  sendContentSchema,
  type SendContentInput,
} from "./outbound.schemas.js";
import type { OutboundRepository, RecipientRef } from "./outbound.repository.js";

/**
 * Outbound WhatsApp messages.
 *  send()            — validates (content, 24h window, opt-in), stores a pending Message
 *                      and enqueues its job in ONE transaction; returns immediately.
 *  processOutbound() — the job: re-checks the rules, calls Meta, stores the wamid.
 * Rules: free-form text only inside the customer service window; templates only to
 * contacts with opt-in (ADR-009). Order per conversation: pg-boss key_strict_fifo.
 */

export interface SendInput {
  recipient: RecipientRef;
  content: SendContentInput;
  author: MessageAuthor;
  /**
   * Why it is sent (phase 7). Default: author human → "human", otherwise "auto_reply"
   * (paused while a person handles the conversation). Digests pass "team_notification".
   */
  purpose?: MessagePurpose;
  authorUserId?: string;
  idempotencyKey?: string;
}

export interface SendOutput {
  messageId: string;
  conversationId: string | null;
  duplicate: boolean;
}

export type OutboundOutcome = "accepted" | "failed" | "already_sent" | "not_found" | "canceled";

export function defaultPurpose(author: MessageAuthor): MessagePurpose {
  return author === "human" ? "human" : "auto_reply";
}

export interface OutboundService {
  send(input: SendInput, log: Logger): Promise<SendOutput>;
  /** Records a manual opt-in (operator confirmed consent outside WhatsApp). */
  recordManualOptIn(ref: { waId: string } | { bsuid: string }, log: Logger): Promise<void>;
  processOutbound(
    messageId: string,
    log: Logger,
    options: { finalAttempt: boolean },
  ): Promise<{ outcome: OutboundOutcome; reason?: string }>;
}

function templateSummary(content: Extract<SendContent, { kind: "template" }>): string {
  const params = (content.components ?? []).flatMap((c) => c.parameters.map((p) => p.text));
  return `[template ${content.name} ${content.languageCode}]${params.length ? ` ${params.join(" | ")}` : ""}`;
}

export interface OutOptOutSettings {
  getAll(log: Logger): Promise<Record<string, unknown>>;
}

export function createOutboundService(deps: {
  repository: OutboundRepository;
  client: WhatsAppSendClient;
  now?: () => Date;
  /** When provided, an auto reply gets the opt-out instruction appended (ADR-017). */
  settings?: OutOptOutSettings;
}): OutboundService {
  const now = deps.now ?? (() => new Date());

  return {
    async send(input, log) {
      const content = sendContentSchema.parse(input.content) as SendContent;
      const idempotencyKey =
        input.idempotencyKey === undefined
          ? undefined
          : idempotencyKeySchema.parse(input.idempotencyKey);

      if (idempotencyKey) {
        const existing = await deps.repository.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          log.info({ messageId: existing.id }, "outbound send deduplicated by idempotency key");
          return { messageId: existing.id, conversationId: null, duplicate: true };
        }
      }

      const found = await deps.repository.findRecipient(input.recipient);
      if (content.kind === "text") {
        const window = customerServiceWindow(found?.conversation?.lastInboundAt ?? null, now());
        if (!found || !window.open) {
          throw errors.windowClosed({
            lastInboundAt: found?.conversation?.lastInboundAt?.toISOString() ?? null,
            closedAt: window.closesAt?.toISOString() ?? null,
          });
        }
      } else if (!found?.contact.optInAt) {
        throw errors.optInRequired({ contactId: found?.contact.id ?? null });
      }
      // `found` is non-null past the checks above.
      const { contact, conversation } = found as NonNullable<typeof found>;
      const purpose = input.purpose ?? defaultPurpose(input.author);
      // Opt-out (ADR-017): blocks everything WE initiate except the compliance reply
      // itself and a person's own reply (still allowed inside the window, with a warning
      // in the panel).
      if (contact.optOutAt && purpose !== "compliance" && purpose !== "human") {
        throw errors.optedOut({ contactId: contact.id, optOutAt: contact.optOutAt.toISOString() });
      }
      // Human takeover (ADR-016): automatic replies to this contact are paused.
      if (purpose === "auto_reply" && conversation?.mode === "human") {
        throw errors.humanMode({
          conversationId: conversation.id,
          humanUntil: conversation.humanUntil?.toISOString() ?? null,
        });
      }

      let optOutInstructionCutoff: Date | undefined;
      if (purpose === "auto_reply" && content.kind === "text" && deps.settings) {
        const reminderDays = (await deps.settings.getAll(log))[
          "optOut.instructionReminderDays"
        ] as number;
        optOutInstructionCutoff = new Date(now().getTime() - reminderDays * 24 * 3_600_000);
      }

      const recipient: SendRecipient = contact.waId
        ? { waId: contact.waId }
        : { bsuid: contact.bsuid as string };
      const created = await deps.repository.createOutbound({
        contactId: contact.id,
        type: content.kind,
        text: content.kind === "text" ? content.body : templateSummary(content),
        author: input.author,
        purpose,
        ...(input.authorUserId ? { authorUserId: input.authorUserId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(optOutInstructionCutoff ? { optOutInstructionCutoff } : {}),
        request: buildSendPayload(recipient, content),
      });
      log.info(
        {
          messageId: created.messageId,
          conversationId: created.conversationId,
          kind: content.kind,
          to: contact.waId ? maskPhone(contact.waId) : maskUserId(contact.bsuid),
          duplicate: created.duplicate,
        },
        "outbound message queued",
      );
      return created;
    },

    async recordManualOptIn(ref, log) {
      const result = await deps.repository.recordOptIn(ref, "manual", now());
      log.info(
        {
          contactId: result.contactId,
          optInSource: result.optInSource,
          created: result.created,
        },
        "opt-in recorded",
      );
    },

    async processOutbound(messageId, log, { finalAttempt }) {
      const message = await deps.repository.getForSend(messageId);
      if (!message) {
        log.warn({ messageId }, "outbound message not found");
        return { outcome: "not_found" };
      }
      if (message.status !== "pending" || message.waMessageId) {
        log.debug({ messageId, status: message.status }, "outbound already sent, skipping");
        return { outcome: "already_sent" };
      }

      const fail = async (code: string, reason: string) => {
        await deps.repository.markFailed(messageId, code, reason);
        log.warn({ messageId, errorCode: code, reason }, "outbound message failed");
        return { outcome: "failed" as const, reason: code };
      };

      // Re-check: the window may have closed while the job waited in the queue.
      if (message.type === "text") {
        if (!customerServiceWindow(message.lastInboundAt, now()).open) {
          return fail("window_closed", "Customer service window closed before sending");
        }
      } else if (!message.contactOptInAt) {
        return fail("opt_in_required", "Contact has no opt-in");
      }
      // Re-check: the contact may have opted out while this message waited in the queue.
      if (
        message.contactOptOutAt &&
        message.purpose !== "compliance" &&
        message.purpose !== "human"
      ) {
        return fail("opted_out", "Contact opted out of business-initiated messages");
      }

      // Last gate before Meta, under the conversation lock (ADR-016).
      const claim = await deps.repository.claimForSend(messageId, now());
      if (claim === "canceled") {
        log.info({ messageId }, "automatic reply cancelled: a person is handling the conversation");
        return { outcome: "canceled", reason: "human_takeover" };
      }
      if (claim === "not_pending") return { outcome: "already_sent" };

      let result;
      try {
        result = await deps.client.send(message.request);
      } catch (err) {
        if (!(err instanceof WhatsAppSendError)) throw err;
        const code = err.metaCode !== undefined ? String(err.metaCode) : err.category;
        if (err.category === "unauthorized") {
          log.error("WhatsApp access token invalid or expired: renew WHATSAPP_ACCESS_TOKEN");
        }
        if (err.retryable && !finalAttempt) {
          log.warn(
            { messageId, category: err.category, code },
            "outbound send failed (will retry)",
          );
          throw err;
        }
        // Final attempt or permanent error: settle the job WITHOUT throwing, so the
        // key_strict_fifo queue never keeps a failed job blocking the conversation.
        return fail(code, err.message);
      }

      // Meta accepted the message. From here on NEVER throw: a retry would send it twice.
      try {
        const { appliedStatuses } = await deps.repository.markAccepted(messageId, {
          wamid: result.wamid,
          response: {
            messageStatus: result.messageStatus,
            waId: result.waId,
            userId: result.userId,
          },
          at: now(),
        });
        const level = result.messageStatus && result.messageStatus !== "accepted" ? "warn" : "info";
        log[level](
          {
            messageId,
            wamid: result.wamid,
            messageStatus: result.messageStatus,
            appliedStatuses,
          },
          "outbound message accepted by WhatsApp",
        );
        return { outcome: "accepted" };
      } catch (err) {
        log.error(
          { err, messageId, wamid: result.wamid },
          "outbound message SENT but its wamid could not be stored (not retried to avoid a duplicate)",
        );
        return { outcome: "accepted", reason: "wamid_not_stored" };
      }
    },
  };
}
