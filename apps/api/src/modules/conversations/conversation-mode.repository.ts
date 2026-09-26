import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { ConversationMode, ConversationModeReason } from "../../generated/prisma/enums.js";
import {
  nextMode,
  type ModeDecision,
  type ModeEvent,
  type ModeState,
} from "./conversation-mode.js";

/**
 * Conversation mode persistence (phase 7, ADR-016). Every change runs in ONE transaction
 * holding the conversation row lock (SELECT … FOR UPDATE): the same lock the outbound
 * worker takes to claim a message (`OutboundRepository.claimForSend`), so a human takeover
 * and a bot send can never interleave.
 */

/** Schedules the automatic reactivation inside the caller's transaction (pg-boss). */
export type ScheduleBotResumeInTx = (
  tx: Prisma.TransactionClient,
  input: { conversationId: string; at: Date },
) => Promise<void>;

export interface ModeActor {
  userId?: string;
  /** e.g. "cli:ana", "system", "whatsapp-app". */
  label?: string;
}

export interface ApplyModeEventResult {
  conversationId: string;
  decision: ModeDecision;
  state: ModeState;
  /** Automatic replies cancelled by this change. */
  canceledMessages: number;
}

export type ConversationRef = { conversationId: string } | { waId: string } | { bsuid: string };

export interface ConversationModeView extends ModeState {
  conversationId: string;
  contactId: string;
  lastChange: {
    reason: ConversationModeReason;
    at: Date;
    actorUserId: string | null;
    actorLabel: string | null;
  } | null;
}

export interface ApplyModeEventInput {
  conversationId: string;
  event: ModeEvent;
  actor: ModeActor;
  messageId?: string;
  now: Date;
  takeoverMinutes: number;
}

export interface ConversationModeRepository {
  apply(input: ApplyModeEventInput): Promise<ApplyModeEventResult>;
  /** Same, inside the caller's transaction (e.g. the echo that caused it is stored in it). */
  applyInTx(
    tx: Prisma.TransactionClient,
    input: ApplyModeEventInput,
  ): Promise<ApplyModeEventResult>;
  find(ref: ConversationRef): Promise<ConversationModeView | null>;
  /** Human conversations whose humanUntil passed (lost reactivation jobs). */
  findExpired(now: Date, limit: number): Promise<string[]>;
}

export const HUMAN_TAKEOVER_CODE = "human_takeover";

export function createConversationModeRepository(
  prisma: PrismaClient,
  deps: { scheduleBotResumeInTx: ScheduleBotResumeInTx },
): ConversationModeRepository {
  async function applyInTx(
    tx: Prisma.TransactionClient,
    { conversationId, event, actor, messageId, now, takeoverMinutes }: ApplyModeEventInput,
  ): Promise<ApplyModeEventResult> {
    const rows = await tx.$queryRaw<
      { mode: ConversationMode; human_until: Date | null; mode_changed_at: Date | null }[]
    >`SELECT mode, human_until, mode_changed_at FROM conversations
           WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error(`conversation ${conversationId} not found`);
    const state: ModeState = {
      mode: row.mode,
      humanUntil: row.human_until,
      modeChangedAt: row.mode_changed_at,
    };
    const decision = nextMode(state, event, now, takeoverMinutes);
    if (!decision.changed) return { conversationId, decision, state, canceledMessages: 0 };

    const { next } = decision;
    await tx.conversation.update({
      where: { id: conversationId },
      data: { mode: next.mode, humanUntil: next.humanUntil, modeChangedAt: next.modeChangedAt },
    });
    await tx.conversationModeChange.create({
      data: {
        conversationId,
        fromMode: state.mode,
        toMode: next.mode,
        humanUntil: next.humanUntil,
        reason: decision.reason,
        actorUserId: actor.userId ?? null,
        actorLabel: actor.label ?? null,
        messageId: messageId ?? null,
      },
    });

    let canceledMessages = 0;
    if (decision.cancelPendingAutoReplies) {
      // Not claimed = not in flight: the worker has not called Meta yet.
      const canceled = await tx.message.updateMany({
        where: {
          conversationId,
          direction: "outbound",
          purpose: "auto_reply",
          status: "pending",
          claimedAt: null,
          waMessageId: null,
        },
        data: {
          status: "canceled",
          statusAt: now,
          errorCode: HUMAN_TAKEOVER_CODE,
          errorMessage: "Cancelled: a person took over the conversation",
        },
      });
      canceledMessages = canceled.count;
    }
    if (decision.scheduleResumeAt) {
      await deps.scheduleBotResumeInTx(tx, { conversationId, at: decision.scheduleResumeAt });
    }
    return { conversationId, decision, state: next, canceledMessages };
  }

  return {
    apply: (input) => prisma.$transaction((tx) => applyInTx(tx, input)),
    applyInTx,

    async find(ref) {
      const where =
        "conversationId" in ref
          ? { id: ref.conversationId }
          : { contact: "waId" in ref ? { waId: ref.waId } : { bsuid: ref.bsuid } };
      const conversation = await prisma.conversation.findFirst({
        where,
        select: {
          id: true,
          contactId: true,
          mode: true,
          humanUntil: true,
          modeChangedAt: true,
          modeChanges: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { reason: true, createdAt: true, actorUserId: true, actorLabel: true },
          },
        },
      });
      if (!conversation) return null;
      const last = conversation.modeChanges[0];
      return {
        conversationId: conversation.id,
        contactId: conversation.contactId,
        mode: conversation.mode,
        humanUntil: conversation.humanUntil,
        modeChangedAt: conversation.modeChangedAt,
        lastChange: last
          ? {
              reason: last.reason,
              at: last.createdAt,
              actorUserId: last.actorUserId,
              actorLabel: last.actorLabel,
            }
          : null,
      };
    },

    async findExpired(now, limit) {
      const rows = await prisma.conversation.findMany({
        where: { mode: "human", humanUntil: { lte: now } },
        select: { id: true },
        orderBy: { humanUntil: "asc" },
        take: limit,
      });
      return rows.map((r) => r.id);
    },
  };
}
