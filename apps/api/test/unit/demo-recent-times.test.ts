import { describe, expect, it } from "vitest";
import { localDay } from "../../src/modules/dashboard/dashboard-rules.js";
import { localDayStart, recentNewsTimes } from "../../src/modules/demo/recent-times.js";

/** The demo seed's recent news land on "Today" and "Yesterday" at any hour (phase 15). */

// Montevideo is UTC−3 (no daylight saving time since 2015).
const at = (iso: string) => new Date(iso);

describe("recent news times", () => {
  it("the local day starts at 03:00 UTC in Montevideo", () => {
    expect(localDayStart(at("2026-10-12T15:00:00Z")).toISOString()).toBe(
      "2026-10-12T03:00:00.000Z",
    );
    // 01:30 UTC is still the 11th in Montevideo.
    expect(localDayStart(at("2026-10-12T01:30:00Z")).toISOString()).toBe(
      "2026-10-11T03:00:00.000Z",
    );
  });

  it("at 00:10 in Montevideo: today is midnight (not one hour ago, yesterday), yesterday is its noon", () => {
    const now = at("2026-10-12T03:10:00Z"); // 00:10 local
    const { today, yesterday } = recentNewsTimes(now);
    expect(today.toISOString()).toBe("2026-10-12T03:00:00.000Z");
    expect(localDay(today)).toBe("2026-10-12");
    expect(today.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(yesterday.toISOString()).toBe("2026-10-11T15:00:00.000Z"); // 12:00 local on the 11th
    expect(localDay(yesterday)).toBe("2026-10-11");
  });

  it("during the day: today is one hour ago, yesterday is the previous local day's noon", () => {
    const now = at("2026-10-12T18:00:00Z"); // 15:00 local
    const { today, yesterday } = recentNewsTimes(now);
    expect(today.toISOString()).toBe("2026-10-12T17:00:00.000Z");
    expect(localDay(yesterday)).toBe("2026-10-11");
  });

  it("just before midnight: still today and yesterday", () => {
    const now = at("2026-10-13T02:59:00Z"); // 23:59 local on the 12th
    const { today, yesterday } = recentNewsTimes(now);
    expect(localDay(today)).toBe("2026-10-12");
    expect(localDay(yesterday)).toBe("2026-10-11");
  });

  it("a month boundary", () => {
    const { today, yesterday } = recentNewsTimes(at("2026-11-01T03:05:00Z")); // 00:05 on Nov 1
    expect(localDay(today)).toBe("2026-11-01");
    expect(localDay(yesterday)).toBe("2026-10-31");
  });
});
