import {
  businessTexts,
  toBusinessLanguage,
  type BusinessLanguage,
} from "../../common/business-texts.js";
import { AppError, errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { autoReplyAllowed } from "../conversations/conversation-mode.js";
import type { OutboundService } from "../messaging/outbound.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { NotificationRepository } from "./notification.repository.js";

/**
 * Acknowledgement to the supplier ("We received your list: 5 prices updated…"), phase 6; in the
 * business language since phase 13.
 * OFF by default (Setting bot.supplierAck; ON in demo mode). The text is composed by the
 * backend from the run report (n8n never sends free text to a contact). Sent inside the
 * 24 h window the supplier just opened (free), never when a human is handling the
 * conversation nor for a message received while a human was handling it (ADR-016), and at
 * most once per run (idempotencyKey ack:<runId>).
 */

export interface AckContext {
  status: string;
  counts: { created?: number; updated?: number; review?: number } | null;
  pendingReviews: number;
  contactKind: string;
  conversationId: string;
  conversationMode: "bot" | "human";
  humanUntil: Date | null;
  modeChangedAt: Date | null;
  /** When the run's message reached us. */
  messageReceivedAt: Date;
}

export function ackText(ctx: AckContext, language: BusinessLanguage = "es"): string {
  const { ack } = businessTexts(language);
  if (ctx.status === "needs_review") return ack.underReview;
  const updated = ctx.counts?.updated ?? 0;
  const created = ctx.counts?.created ?? 0;
  const review = ctx.pendingReviews;
  const parts: string[] = [];
  if (updated > 0) parts.push(ack.pricesUpdated(updated));
  if (created > 0) parts.push(ack.newProducts(created));
  const head = parts.length > 0 ? ack.listWith(parts) : ack.listNoChanges;
  return ack.thanks(review > 0 ? `${head} ${ack.pendingReview(review)}` : head);
}

export function createSupplierAckService(deps: {
  repository: Pick<NotificationRepository, "ackContext">;
  settings: SettingsService;
  outbound: OutboundService;
}) {
  return {
    async ack(
      runId: string,
      log: Logger,
    ): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
      const all = await deps.settings.getAll(log);
      if (!(all["bot.supplierAck"] as boolean)) return { sent: false, reason: "disabled" };
      // Global switch (phase 9 M6): no automatic reply to anyone.
      if (all["bot.autoRepliesEnabled"] === false)
        return { sent: false, reason: "auto_replies_off" };
      const ctx = await deps.repository.ackContext(runId);
      if (!ctx) throw errors.notFound("Ingestion run not found");
      if (!["ingested", "needs_review"].includes(ctx.status))
        return { sent: false, reason: `run_${ctx.status}` };
      if (ctx.contactKind !== "supplier") return { sent: false, reason: "not_a_supplier" };
      const mode = {
        mode: ctx.conversationMode,
        humanUntil: ctx.humanUntil,
        modeChangedAt: ctx.modeChangedAt,
      };
      if (!autoReplyAllowed(mode, ctx.messageReceivedAt))
        return {
          sent: false,
          reason: ctx.conversationMode === "human" ? "human_mode" : "received_during_human_mode",
        };
      try {
        const sent = await deps.outbound.send(
          {
            recipient: { conversationId: ctx.conversationId },
            content: {
              kind: "text",
              body: ackText(ctx, toBusinessLanguage(all["business.language"])),
            },
            author: "bot",
            purpose: "auto_reply",
            idempotencyKey: `ack:${runId}`,
          },
          log,
        );
        return { sent: true, messageId: sent.messageId };
      } catch (err) {
        // A person took over between the check and the send.
        if (err instanceof AppError && err.code === "HUMAN_MODE")
          return { sent: false, reason: "human_mode" };
        // Opted-out supplier (ADR-017): the list is still ingested and updates the
        // catalog (this method runs after that); only the acknowledgement is skipped.
        if (err instanceof AppError && err.code === "OPTED_OUT")
          return { sent: false, reason: "opted_out" };
        throw err;
      }
    },
  };
}
export type SupplierAckService = ReturnType<typeof createSupplierAckService>;
