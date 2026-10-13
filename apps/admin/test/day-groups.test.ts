import { describe, expect, it } from "vitest";
import { groupByDay, localDay, previousDay } from "../src/lib/day-groups";

/** Activity grouped by the business's local day (phase 15 M4). Montevideo is UTC−3. */

const NOW = new Date("2026-10-12T15:00:00Z"); // 12:00 in Montevideo

describe("day groups", () => {
  it("uses the business time zone, not UTC", () => {
    // 01:30 UTC on the 12th is still the 11th in Montevideo.
    expect(localDay("2026-10-12T01:30:00Z")).toBe("2026-10-11");
    expect(localDay("2026-10-12T03:30:00Z")).toBe("2026-10-12");
  });

  it("previous day across months and years", () => {
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });

  it("today, yesterday, then dates — newest day first, item order kept inside a day", () => {
    const items = [
      { id: "a", at: "2026-10-12T14:00:00Z" },
      { id: "b", at: "2026-10-12T04:00:00Z" },
      { id: "c", at: "2026-10-12T02:00:00Z" }, // 23:00 on the 11th, local
      { id: "d", at: "2026-10-08T12:00:00Z" },
      { id: "e", at: "2026-10-11T20:00:00Z" },
    ];
    const groups = groupByDay(items, (i) => i.at, NOW);
    expect(groups.map((g) => [g.day, g.label.kind, g.items.map((i) => i.id)])).toEqual([
      ["2026-10-12", "today", ["a", "b"]],
      ["2026-10-11", "yesterday", ["c", "e"]],
      ["2026-10-08", "date", ["d"]],
    ]);
  });

  it("nothing → no groups", () => {
    expect(groupByDay([], (i: { at: string }) => i.at, NOW)).toEqual([]);
  });
});
