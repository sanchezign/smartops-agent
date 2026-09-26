import type { ConversationMode, ConversationModeReason } from "../../generated/prisma/enums.js";

/**
 * Bot / human mode of a conversation (phase 7, ADR-016) — pure rules, no I/O.
 *
 * - bot: automatic replies allowed.
 * - human: a person is handling the chat; automatic replies to THIS contact are paused
 *   (list processing, catalog and team notifications are not). `humanUntil` = when the
 *   bot comes back by itself; null = until someone reactivates it.
 *
 * Events: a human message (panel reply or WhatsApp Business app echo), manual pause,
 * manual resume, timeout. Contact messages never change the mode (a chatty contact must
 * not keep the bot off forever).
 */

export interface ModeState {
  mode: ConversationMode;
  humanUntil: Date | null;
  modeChangedAt: Date | null;
}

export type ModeEvent =
  | {
      type: "human_message";
      source: "panel" | "app";
      /** When the person wrote it (WhatsApp timestamp for echoes); orders late echoes. */
      messageAt?: Date;
    }
  /** until: null = until manual reactivation. */
  | { type: "pause"; until: Date | null }
  | { type: "resume" }
  | { type: "timeout" };

export type ModeDecision =
  | {
      changed: true;
      next: ModeState;
      reason: ConversationModeReason;
      /** Cancel queued automatic replies that are not in flight yet. */
      cancelPendingAutoReplies: boolean;
      /** Schedule the automatic reactivation at this instant. */
      scheduleResumeAt: Date | null;
    }
  | { changed: false; ignored: string };

const MINUTE = 60_000;

/**
 * Next state (pure). `takeoverMinutes` = Setting coexistence.humanTakeoverMinutes.
 * The timeout counts from when the SERVER sees the event (`now`), not from Meta's
 * timestamp (clock skew); `messageAt` is only used to order late echoes.
 */
export function nextMode(
  state: ModeState,
  event: ModeEvent,
  now: Date,
  takeoverMinutes: number,
): ModeDecision {
  switch (event.type) {
    case "human_message": {
      const reason: ConversationModeReason =
        event.source === "panel" ? "human_reply_panel" : "human_reply_app";
      // A late echo written BEFORE the last change back to bot (manual resume / timeout)
      // must not pause the bot again: that person was answering before the resume.
      if (
        state.mode === "bot" &&
        event.messageAt &&
        state.modeChangedAt &&
        event.messageAt.getTime() < state.modeChangedAt.getTime()
      ) {
        return { changed: false, ignored: "stale_human_message" };
      }
      const until = new Date(now.getTime() + takeoverMinutes * MINUTE);
      if (state.mode === "human") {
        // Indefinite pause stays indefinite; otherwise only EXTEND (never shorten).
        if (state.humanUntil === null)
          return {
            changed: true,
            next: state,
            reason,
            cancelPendingAutoReplies: true,
            scheduleResumeAt: null,
          };
        const extended = until.getTime() > state.humanUntil.getTime() ? until : state.humanUntil;
        return {
          changed: true,
          next: { ...state, humanUntil: extended },
          reason,
          cancelPendingAutoReplies: true,
          scheduleResumeAt: extended === until ? until : null,
        };
      }
      return {
        changed: true,
        next: { mode: "human", humanUntil: until, modeChangedAt: now },
        reason,
        cancelPendingAutoReplies: true,
        scheduleResumeAt: until,
      };
    }

    case "pause": {
      if (event.until && event.until.getTime() <= now.getTime())
        return { changed: false, ignored: "pause_until_in_the_past" };
      return {
        changed: true,
        next: {
          mode: "human",
          humanUntil: event.until,
          modeChangedAt: state.mode === "human" ? state.modeChangedAt : now,
        },
        reason: "manual_pause",
        cancelPendingAutoReplies: true,
        scheduleResumeAt: event.until,
      };
    }

    case "resume":
      if (state.mode === "bot") return { changed: false, ignored: "already_bot" };
      return {
        changed: true,
        next: { mode: "bot", humanUntil: null, modeChangedAt: now },
        reason: "manual_resume",
        cancelPendingAutoReplies: false,
        scheduleResumeAt: null,
      };

    case "timeout":
      if (state.mode === "bot") return { changed: false, ignored: "already_bot" };
      if (state.humanUntil === null) return { changed: false, ignored: "indefinite_pause" };
      // Extended since the job was scheduled → a newer job will come.
      if (state.humanUntil.getTime() > now.getTime())
        return { changed: false, ignored: "not_expired" };
      return {
        changed: true,
        next: { mode: "bot", humanUntil: null, modeChangedAt: now },
        reason: "timeout",
        cancelPendingAutoReplies: false,
        scheduleResumeAt: null,
      };
  }
}

/**
 * May an automatic reply be sent for a message received at `receivedAt`? Only in bot mode
 * and only if the message arrived after the last change back to bot: a message the
 * contact sent while a human was handling the chat gets no delayed bot reply.
 */
export function autoReplyAllowed(state: ModeState, receivedAt: Date | null): boolean {
  if (state.mode !== "bot") return false;
  if (!state.modeChangedAt || !receivedAt) return true;
  return receivedAt.getTime() >= state.modeChangedAt.getTime();
}
