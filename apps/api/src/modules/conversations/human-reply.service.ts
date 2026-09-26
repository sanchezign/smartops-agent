import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { OutboundService } from "../messaging/outbound.service.js";
import type {
  ApplyModeEventResult,
  ConversationRef,
  ModeActor,
} from "./conversation-mode.repository.js";
import type { ConversationModeService } from "./conversation-mode.service.js";

/**
 * A person replies to a contact from the panel (phase 9; CLI `wa:reply` until then).
 * Order: queue the human message first (the 24 h window is checked there — no takeover if
 * it cannot be sent), then take over: pending automatic replies are cancelled and the bot
 * pauses for `coexistence.humanTakeoverMinutes` (ADR-016).
 */
export interface HumanReplyResult {
  messageId: string;
  conversationId: string;
  duplicate: boolean;
  takeover: ApplyModeEventResult;
}

export function createHumanReplyService(deps: {
  outbound: Pick<OutboundService, "send">;
  mode: Pick<ConversationModeService, "apply" | "status">;
}) {
  return {
    async reply(
      ref: ConversationRef,
      input: { text: string; userId?: string; idempotencyKey?: string },
      actor: ModeActor,
      log: Logger,
    ): Promise<HumanReplyResult> {
      const sent = await deps.outbound.send(
        {
          recipient: ref,
          content: { kind: "text", body: input.text },
          author: "human",
          purpose: "human",
          ...(input.userId ? { authorUserId: input.userId } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
        log,
      );
      const conversationId =
        sent.conversationId ?? (await deps.mode.status(ref))?.conversationId ?? null;
      if (!conversationId) throw errors.notFound("Conversation not found");
      const takeover = await deps.mode.apply(
        conversationId,
        { type: "human_message", source: "panel" },
        actor,
        log,
        { messageId: sent.messageId },
      );
      return { messageId: sent.messageId, conversationId, duplicate: sent.duplicate, takeover };
    },
  };
}
export type HumanReplyService = ReturnType<typeof createHumanReplyService>;
