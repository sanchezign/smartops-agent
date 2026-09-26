import { describe, expect, it } from "vitest";
import {
  autoReplyAllowed,
  nextMode,
  type ModeEvent,
  type ModeState,
} from "../../src/modules/conversations/conversation-mode.js";

/** Pure bot/human state machine (phase 7, ADR-016). */

const NOW = new Date("2026-09-26T12:00:00Z");
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
const TAKEOVER = 120;

const bot: ModeState = { mode: "bot", humanUntil: null, modeChangedAt: null };
const botResumedAt = (m: number): ModeState => ({
  mode: "bot",
  humanUntil: null,
  modeChangedAt: min(m),
});
const humanUntil = (m: number | null): ModeState => ({
  mode: "human",
  humanUntil: m === null ? null : min(m),
  modeChangedAt: min(-10),
});

const panel: ModeEvent = { type: "human_message", source: "panel" };
const app: ModeEvent = { type: "human_message", source: "app" };

describe("nextMode — every state × event", () => {
  it.each([
    // [state, event, expected mode, expected humanUntil (min from now; null), reason]
    ["bot", bot, panel, "human", 120, "human_reply_panel"],
    ["bot", bot, app, "human", 120, "human_reply_app"],
    ["bot", bot, { type: "pause", until: null }, "human", null, "manual_pause"],
    ["bot", bot, { type: "pause", until: min(60) }, "human", 60, "manual_pause"],
    ["human 30", humanUntil(30), panel, "human", 120, "human_reply_panel"],
    ["human 300", humanUntil(300), app, "human", 300, "human_reply_app"],
    ["human ∞", humanUntil(null), app, "human", null, "human_reply_app"],
    ["human 30", humanUntil(30), { type: "pause", until: null }, "human", null, "manual_pause"],
    ["human ∞", humanUntil(null), { type: "pause", until: min(15) }, "human", 15, "manual_pause"],
    ["human 30", humanUntil(30), { type: "resume" }, "bot", null, "manual_resume"],
    ["human ∞", humanUntil(null), { type: "resume" }, "bot", null, "manual_resume"],
    ["human expired", humanUntil(-1), { type: "timeout" }, "bot", null, "timeout"],
    ["human exactly now", humanUntil(0), { type: "timeout" }, "bot", null, "timeout"],
  ] as const)("%s + %o → %s", (_label, state, event, mode, untilMin, reason) => {
    const decision = nextMode(state, event as ModeEvent, NOW, TAKEOVER);
    expect(decision.changed).toBe(true);
    if (!decision.changed) return;
    expect(decision.next.mode).toBe(mode);
    expect(decision.next.humanUntil).toEqual(untilMin === null ? null : min(untilMin));
    expect(decision.reason).toBe(reason);
  });

  it.each([
    ["bot + resume", bot, { type: "resume" }, "already_bot"],
    ["bot + timeout", bot, { type: "timeout" }, "already_bot"],
    ["human ∞ + timeout", humanUntil(null), { type: "timeout" }, "indefinite_pause"],
    ["extended + stale timeout job", humanUntil(30), { type: "timeout" }, "not_expired"],
    ["pause until the past", bot, { type: "pause", until: min(-5) }, "pause_until_in_the_past"],
  ] as const)("%s → ignored (%s)", (_label, state, event, ignored) => {
    expect(nextMode(state, event as ModeEvent, NOW, TAKEOVER)).toEqual({
      changed: false,
      ignored,
    });
  });
});

describe("nextMode — details", () => {
  it("entering human cancels queued automatic replies and schedules the reactivation", () => {
    const d = nextMode(bot, app, NOW, TAKEOVER);
    expect(d).toMatchObject({
      changed: true,
      cancelPendingAutoReplies: true,
      scheduleResumeAt: min(120),
      next: { modeChangedAt: NOW },
    });
  });

  it("a human message never SHORTENS a longer pause (and schedules nothing new)", () => {
    const d = nextMode(humanUntil(300), panel, NOW, TAKEOVER);
    expect(d).toMatchObject({
      changed: true,
      scheduleResumeAt: null,
      next: { humanUntil: min(300) },
    });
  });

  it("extending keeps the original takeover time (modeChangedAt)", () => {
    const d = nextMode(humanUntil(30), panel, NOW, TAKEOVER);
    expect(d).toMatchObject({ next: { modeChangedAt: min(-10) }, scheduleResumeAt: min(120) });
  });

  it("a late echo written BEFORE the last resume does not pause again", () => {
    const d = nextMode(
      botResumedAt(-5),
      { type: "human_message", source: "app", messageAt: min(-6) },
      NOW,
      TAKEOVER,
    );
    expect(d).toEqual({ changed: false, ignored: "stale_human_message" });
  });

  it("an echo written AFTER the resume pauses again", () => {
    const d = nextMode(
      botResumedAt(-5),
      { type: "human_message", source: "app", messageAt: min(-1) },
      NOW,
      TAKEOVER,
    );
    expect(d).toMatchObject({ changed: true, next: { mode: "human" } });
  });

  it("resume and timeout never cancel anything nor schedule", () => {
    for (const event of [{ type: "resume" }, { type: "timeout" }] as ModeEvent[]) {
      expect(nextMode(humanUntil(-1), event, NOW, TAKEOVER)).toMatchObject({
        cancelPendingAutoReplies: false,
        scheduleResumeAt: null,
      });
    }
  });

  it("the takeover time comes from the setting", () => {
    expect(nextMode(bot, panel, NOW, 1)).toMatchObject({ next: { humanUntil: min(1) } });
  });
});

describe("autoReplyAllowed", () => {
  it("only in bot mode", () => {
    expect(autoReplyAllowed(bot, NOW)).toBe(true);
    expect(autoReplyAllowed(humanUntil(30), NOW)).toBe(false);
  });

  it("no delayed reply for a message received while a human was handling the chat", () => {
    expect(autoReplyAllowed(botResumedAt(-5), min(-20))).toBe(false);
    expect(autoReplyAllowed(botResumedAt(-5), min(-1))).toBe(true);
  });
});
