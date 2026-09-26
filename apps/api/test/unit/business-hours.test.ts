import { describe, expect, it } from "vitest";
import { isOpen, nextOpening, zonedTimeToUtc } from "../../src/modules/settings/business-hours.js";
import { businessHoursSchema } from "../../src/modules/settings/settings.schemas.js";

/** Business hours (phase 9 M6): Montevideo is UTC−3 all year; New York exercises DST. */

const MVD = "America/Montevideo";
const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: "09:00", close: "18:00" }));
const hours = { timeZone: MVD, days: [...weekdays, { day: 6, open: "09:00", close: "13:00" }] };
const utc = (iso: string) => new Date(iso);

describe("isOpen", () => {
  it.each([
    ["2026-09-28T12:00:00Z", true], // Mon 09:00 local — opening minute
    ["2026-09-28T20:59:00Z", true], // Mon 17:59
    ["2026-09-28T21:00:00Z", false], // Mon 18:00 — closed
    ["2026-10-03T15:59:00Z", true], // Sat 12:59
    ["2026-10-03T16:00:00Z", false], // Sat 13:00
    ["2026-10-04T15:00:00Z", false], // Sunday
  ])("%s → %s", (at, open) => {
    expect(isOpen(hours, utc(at))).toBe(open);
  });

  it("no configuration = always open", () => {
    expect(isOpen(null, utc("2026-10-04T03:00:00Z"))).toBe(true);
  });

  it("an overnight rule belongs to the day it opens", () => {
    const night = { timeZone: MVD, days: [{ day: 5, open: "20:00", close: "02:00" }] };
    expect(isOpen(night, utc("2026-10-02T23:30:00Z"))).toBe(true); // Fri 20:30
    expect(isOpen(night, utc("2026-10-03T04:30:00Z"))).toBe(true); // Sat 01:30
    expect(isOpen(night, utc("2026-10-03T05:00:00Z"))).toBe(false); // Sat 02:00
    expect(isOpen(night, utc("2026-10-02T04:30:00Z"))).toBe(false); // Fri 01:30 (Thu had none)
  });
});

describe("nextOpening", () => {
  it("open now → now; evening → tomorrow 09:00; Saturday afternoon → Monday 09:00", () => {
    const now = utc("2026-09-28T13:00:00Z");
    expect(nextOpening(hours, now)).toBe(now);
    expect(nextOpening(hours, utc("2026-09-28T22:00:00Z"))).toEqual(utc("2026-09-29T12:00:00Z"));
    expect(nextOpening(hours, utc("2026-10-03T17:00:00Z"))).toEqual(utc("2026-10-05T12:00:00Z"));
    expect(nextOpening(hours, utc("2026-09-29T03:00:00Z"))).toEqual(utc("2026-09-29T12:00:00Z"));
  });

  it("no days configured → never opens (null)", () => {
    expect(nextOpening({ timeZone: MVD, days: [] }, utc("2026-09-28T13:00:00Z"))).toBeNull();
  });

  it("DST-safe: 09:00 in New York is 13:00Z in summer and 14:00Z in winter", () => {
    const ny = { timeZone: "America/New_York", days: [{ day: 1, open: "09:00", close: "17:00" }] };
    expect(nextOpening(ny, utc("2026-10-31T12:00:00Z"))).toEqual(utc("2026-11-02T14:00:00Z"));
    expect(nextOpening(ny, utc("2026-06-27T12:00:00Z"))).toEqual(utc("2026-06-29T13:00:00Z"));
    expect(
      zonedTimeToUtc({ year: 2026, month: 7, day: 1, minutes: 9 * 60 }, "America/New_York"),
    ).toEqual(utc("2026-07-01T13:00:00Z"));
  });
});

describe("businessHoursSchema", () => {
  it("rejects unknown zones, bad times and empty ranges", () => {
    expect(businessHoursSchema.safeParse(hours).success).toBe(true);
    expect(businessHoursSchema.safeParse({ timeZone: "Mars/Olympus", days: [] }).success).toBe(
      false,
    );
    expect(
      businessHoursSchema.safeParse({
        timeZone: MVD,
        days: [{ day: 1, open: "9:00", close: "18:00" }],
      }).success,
    ).toBe(false);
    expect(
      businessHoursSchema.safeParse({
        timeZone: MVD,
        days: [{ day: 1, open: "09:00", close: "09:00" }],
      }).success,
    ).toBe(false);
  });
});
