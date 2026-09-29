import { businessTexts, toBusinessLanguage } from "../../common/business-texts.js";
import type { Logger } from "../../common/logger.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { CreateOutboundInput, OutboundRepository } from "../messaging/outbound.repository.js";
import type { SettingsService } from "../settings/settings.service.js";
import { buildSendPayload } from "../whatsapp/whatsapp-send.client.js";
import { detectComplianceEvent } from "./optout-detector.js";
import type { OptOutRepository } from "./optout.repository.js";

/**
 * Reacts to a JUST-STORED inbound message, in the SAME transaction (phase 7, ADR-017):
 * detects an opt-out / opt-in keyword or an ambiguous phrase — deterministic, no LLM, so
 * it works even if n8n is down. Never touches supplier lists or the catalog: opt-out only
 * gates messages WE send.
 */
export type OnComplianceMessageInTx = (
  tx: Prisma.TransactionClient,
  input: { contactId: string; messageId: string; text: string | null; at: Date },
) => Promise<{ event: "opt_out" | "opt_in" | "possible_opt_out" | null; applied: boolean }>;

export function createOnComplianceMessageInTx(deps: {
  optOut: Pick<OptOutRepository, "applyInTx">;
  outbound: Pick<OutboundRepository, "createOutboundInTx">;
  settings: SettingsService;
  logger: Logger;
}): OnComplianceMessageInTx {
  return async (tx, { contactId, messageId, text, at }) => {
    if (!text) return { event: null, applied: false };
    const settings = await deps.settings.getAll(deps.logger);
    const detection = detectComplianceEvent(text, {
      optOut: settings["optOut.keywords"] as string[],
      optIn: settings["optIn.keywords"] as string[],
    });
    if (!detection) return { event: null, applied: false };
    const texts = businessTexts(toBusinessLanguage(settings["business.language"]));

    if (detection.kind === "possible_opt_out") {
      await tx.alert.create({
        data: {
          type: "possible_opt_out",
          severity: "info",
          // Technical fallback; the panel shows its own text from the payload (phase 13).
          title: `Possible opt-out (ambiguous phrase: "${detection.matched}")`,
          payload: { contactId, messageId, matched: detection.matched } as Prisma.InputJsonValue,
        },
      });
      deps.logger.info({ contactId, messageId }, "possible opt-out flagged for human review");
      return { event: "possible_opt_out", applied: false };
    }

    const result = await deps.optOut.applyInTx(tx, {
      contactId,
      kind: detection.kind,
      method: "keyword",
      keyword: detection.matched,
      actor: { label: "system" },
      messageId,
      now: at,
    });
    if (!result.changed) {
      deps.logger.debug(
        { contactId, messageId, kind: detection.kind },
        "compliance keyword ignored: nothing to change",
      );
      return { event: detection.kind, applied: false };
    }

    const contact = await tx.contact.findUniqueOrThrow({
      where: { id: contactId },
      select: { waId: true, bsuid: true },
    });
    const recipient = contact.waId ? { waId: contact.waId } : { bsuid: contact.bsuid as string };
    const content = {
      kind: "text" as const,
      body: detection.kind === "opt_out" ? texts.optOutConfirmation : texts.optInConfirmation,
    };
    const input: CreateOutboundInput = {
      contactId,
      type: "text",
      text: content.body,
      author: "bot",
      purpose: "compliance",
      idempotencyKey: `optout-confirm:${messageId}`,
      request: buildSendPayload(recipient, content),
    };
    const queued = await deps.outbound.createOutboundInTx(tx, input);
    deps.logger.info(
      { contactId, messageId, kind: detection.kind, confirmationMessageId: queued.messageId },
      detection.kind === "opt_out" ? "contact opted out" : "contact opted back in",
    );
    return { event: detection.kind, applied: true };
  };
}
