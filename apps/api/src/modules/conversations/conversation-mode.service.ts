import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { ModeEvent } from "./conversation-mode.js";
import type {
  ApplyModeEventResult,
  ConversationModeRepository,
  ConversationModeView,
  ConversationRef,
  ModeActor,
} from "./conversation-mode.repository.js";

/**
 * Bot / human mode (phase 7, ADR-016). Used by: the panel (phase 9) and the CLI
 * (`wa:conversation`) for pause/resume, human replies (panel, WhatsApp Business app echoes
 * in M2), the reactivation job and the sweeper.
 */
export interface ConversationModeService {
  apply(
    conversationId: string,
    event: ModeEvent,
    actor: ModeActor,
    log: Logger,
    options?: { messageId?: string },
  ): Promise<ApplyModeEventResult>;
  pause(
    ref: ConversationRef,
    input: { minutes: number | null },
    actor: ModeActor,
    log: Logger,
  ): Promise<ApplyModeEventResult>;
  resume(ref: ConversationRef, actor: ModeActor, log: Logger): Promise<ApplyModeEventResult>;
  status(ref: ConversationRef): Promise<ConversationModeView | null>;
  /** Reactivation job (startAfter = humanUntil). Stale jobs are no-ops. */
  onTimeout(conversationId: string, log: Logger): Promise<ApplyModeEventResult>;
  /** Safety net for lost reactivation jobs. */
  sweepExpired(log: Logger): Promise<number>;
}

const SWEEP_BATCH = 100;

export function createConversationModeService(deps: {
  repository: ConversationModeRepository;
  settings: SettingsService;
  now?: () => Date;
}): ConversationModeService {
  const now = deps.now ?? (() => new Date());

  async function takeoverMinutes(log: Logger): Promise<number> {
    return (await deps.settings.getAll(log))["coexistence.humanTakeoverMinutes"] as number;
  }

  async function resolve(ref: ConversationRef): Promise<string> {
    if ("conversationId" in ref) return ref.conversationId;
    const found = await deps.repository.find(ref);
    if (!found) throw errors.notFound("Conversation not found");
    return found.conversationId;
  }

  const service: ConversationModeService = {
    async apply(conversationId, event, actor, log, options = {}) {
      const result = await deps.repository.apply({
        conversationId,
        event,
        actor,
        ...(options.messageId ? { messageId: options.messageId } : {}),
        now: now(),
        takeoverMinutes: await takeoverMinutes(log),
      });
      const { decision } = result;
      if (decision.changed) {
        log.info(
          {
            conversationId,
            event: event.type,
            reason: decision.reason,
            mode: result.state.mode,
            humanUntil: result.state.humanUntil,
            canceledMessages: result.canceledMessages,
            actor: actor.userId ?? actor.label,
          },
          "conversation mode changed",
        );
      } else {
        log.debug(
          { conversationId, event: event.type, ignored: decision.ignored },
          "mode event ignored",
        );
      }
      return result;
    },

    async pause(ref, { minutes }, actor, log) {
      const conversationId = await resolve(ref);
      const until = minutes === null ? null : new Date(now().getTime() + minutes * 60_000);
      return service.apply(conversationId, { type: "pause", until }, actor, log);
    },

    async resume(ref, actor, log) {
      return service.apply(await resolve(ref), { type: "resume" }, actor, log);
    },

    status: (ref) => deps.repository.find(ref),

    onTimeout(conversationId, log) {
      return service.apply(conversationId, { type: "timeout" }, { label: "system" }, log);
    },

    async sweepExpired(log) {
      const ids = await deps.repository.findExpired(now(), SWEEP_BATCH);
      let resumed = 0;
      for (const id of ids) {
        const result = await service.onTimeout(id, log);
        if (result.decision.changed) resumed += 1;
      }
      if (resumed > 0)
        log.warn({ resumed }, "sweeper reactivated conversations (lost resume jobs)");
      return resumed;
    },
  };
  return service;
}

/**
 * A person wrote to the contact (WhatsApp Business app echo, phase 7 M2): applied INSIDE
 * the transaction that stores that message, so a retry never stores the echo without the
 * takeover (or the other way round).
 */
export type OnHumanMessageInTx = (
  tx: Prisma.TransactionClient,
  input: { conversationId: string; messageId: string; messageAt: Date | null; source: "app" },
) => Promise<ApplyModeEventResult>;

export function createOnHumanMessageInTx(deps: {
  repository: Pick<ConversationModeRepository, "applyInTx">;
  settings: SettingsService;
  logger: Logger;
  now?: () => Date;
}): OnHumanMessageInTx {
  const now = deps.now ?? (() => new Date());
  return async (tx, input) => {
    const takeoverMinutes = (await deps.settings.getAll(deps.logger))[
      "coexistence.humanTakeoverMinutes"
    ] as number;
    return deps.repository.applyInTx(tx, {
      conversationId: input.conversationId,
      event: {
        type: "human_message",
        source: input.source,
        ...(input.messageAt ? { messageAt: input.messageAt } : {}),
      },
      actor: { label: "whatsapp-business-app" },
      messageId: input.messageId,
      now: now(),
      takeoverMinutes,
    });
  };
}
