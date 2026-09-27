import type { BusinessHours } from "./settings.schemas.js";

/**
 * Business hours (phase 9 M6), pure. Evaluated in the configured IANA time zone (DST-safe:
 * local wall-clock times are converted with Intl, never with a fixed offset). A day rule may
 * cross midnight (close < open: e.g. 20:00 → 02:00 belongs to the day it opens).
 */

const MINUTE = 60_000;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
}

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** A local wall-clock date+time as a comparable, monotonic-in-the-calendar key. */
const localKey = (p: { year: number; month: number; day: number; minutes: number }) =>
  Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes);
/** Widest known DST jump (a handful of zones use 30 min; most use 60 min) — generous margin. */
const DST_SCAN_WINDOW_MS = 4 * 60 * MINUTE;

/**
 * A local wall-clock time in `timeZone` → the UTC instant (two correction passes for DST).
 * If that local time does NOT exist — a spring-forward DST gap skips over it — returns the
 * first instant strictly at or after it, i.e. the moment the clock resumes (phase 10 M9
 * finding: `nextOpening` used to return an instant that reads as CLOSED because the requested
 * opening time never happened that day). Verified against America/New_York, America/Santiago
 * (Southern Hemisphere: gap in September, not March) and Europe/Madrid.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; minutes: number },
  timeZone: string,
): Date {
  const target = localKey(local);
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const seen = localKey(p);
    guess += target - seen;
  }
  if (localKey(localParts(new Date(guess), timeZone)) === target) return new Date(guess);
  // The two-pass correction has no exact fixed point for a nonexistent local time: it can
  // converge to a moment BEFORE the gap. Scan forward in real time (both local clock and
  // calendar key are monotonic outside of the gap itself) for the first instant whose local
  // reading has reached or passed the target.
  for (let t = guess - DST_SCAN_WINDOW_MS; t <= guess + DST_SCAN_WINDOW_MS; t += MINUTE) {
    if (localKey(localParts(new Date(t), timeZone)) >= target) return new Date(t);
  }
  /* c8 ignore next */
  return new Date(guess); // no known zone has a gap this wide; kept as a safe fallback
}

export function isOpen(hours: BusinessHours | null, at: Date): boolean {
  if (!hours) return true;
  const now = localParts(at, hours.timeZone);
  const yesterday = (now.weekday + 6) % 7;
  return hours.days.some((rule) => {
    const open = toMinutes(rule.open);
    const close = toMinutes(rule.close);
    if (open < close) return rule.day === now.weekday && now.minutes >= open && now.minutes < close;
    // Overnight: from `open` on its day until `close` the next day.
    return (
      (rule.day === now.weekday && now.minutes >= open) ||
      (rule.day === yesterday && now.minutes < close)
    );
  });
}

/** When it opens next (now if open; null if no day is configured). */
export function nextOpening(hours: BusinessHours | null, at: Date): Date | null {
  if (!hours || isOpen(hours, at)) return at;
  if (hours.days.length === 0) return null;
  const today = localParts(at, hours.timeZone);
  let best: Date | null = null;
  for (let offset = 0; offset <= 7; offset += 1) {
    // Local calendar date `offset` days ahead (noon avoids DST edges when stepping days).
    const noon = zonedTimeToUtc({ ...today, minutes: 12 * 60 }, hours.timeZone);
    const day = localParts(new Date(noon.getTime() + offset * 24 * 60 * MINUTE), hours.timeZone);
    for (const rule of hours.days) {
      if (rule.day !== day.weekday) continue;
      const opening = zonedTimeToUtc({ ...day, minutes: toMinutes(rule.open) }, hours.timeZone);
      if (opening > at && (!best || opening < best)) best = opening;
    }
    if (best) return best;
  }
  return best;
}
