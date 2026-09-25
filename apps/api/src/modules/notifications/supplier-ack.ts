import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { OutboundService } from "../messaging/outbound.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { NotificationRepository } from "./notification.repository.js";

/**
 * Acknowledgement to the supplier ("Recibimos tu lista: 5 precios actualizados…"), phase 6.
 * OFF by default (Setting bot.supplierAck; ON in demo mode). The text is composed by the
 * backend from the run report (n8n never sends free text to a contact). Sent inside the
 * 24 h window the supplier just opened (free), never when a human is handling the
 * conversation, and at most once per run (idempotencyKey ack:<runId>).
 */

export interface AckContext {
  status: string;
  counts: { created?: number; updated?: number; review?: number } | null;
  pendingReviews: number;
  contactKind: string;
  conversationId: string;
  conversationMode: string;
}

export function ackText(ctx: AckContext): string {
  if (ctx.status === "needs_review")
    return "¡Gracias! Recibimos tu mensaje; nuestro equipo lo revisa y te confirmamos.";
  const updated = ctx.counts?.updated ?? 0;
  const created = ctx.counts?.created ?? 0;
  const review = ctx.pendingReviews;
  const parts: string[] = [];
  if (updated > 0)
    parts.push(`${updated} ${updated === 1 ? "precio actualizado" : "precios actualizados"}`);
  if (created > 0)
    parts.push(`${created} ${created === 1 ? "producto nuevo" : "productos nuevos"}`);
  const head =
    parts.length > 0
      ? `Recibimos tu lista: ${parts.join(", ")}.`
      : "Recibimos tu lista; no hubo cambios de precio.";
  const tail =
    review > 0
      ? ` ${review === 1 ? "Un punto queda" : `${review} puntos quedan`} para revisión de nuestro equipo.`
      : "";
  return `¡Gracias! ${head}${tail}`;
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
      const enabled = (await deps.settings.getAll(log))["bot.supplierAck"] as boolean;
      if (!enabled) return { sent: false, reason: "disabled" };
      const ctx = await deps.repository.ackContext(runId);
      if (!ctx) throw errors.notFound("Ingestion run not found");
      if (!["ingested", "needs_review"].includes(ctx.status))
        return { sent: false, reason: `run_${ctx.status}` };
      if (ctx.contactKind !== "supplier") return { sent: false, reason: "not_a_supplier" };
      if (ctx.conversationMode !== "bot") return { sent: false, reason: "human_mode" };
      const sent = await deps.outbound.send(
        {
          recipient: { conversationId: ctx.conversationId },
          content: { kind: "text", body: ackText(ctx) },
          author: "bot",
          idempotencyKey: `ack:${runId}`,
        },
        log,
      );
      return { sent: true, messageId: sent.messageId };
    },
  };
}
export type SupplierAckService = ReturnType<typeof createSupplierAckService>;
