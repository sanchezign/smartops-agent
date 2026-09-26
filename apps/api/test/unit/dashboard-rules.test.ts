import { describe, expect, it } from "vitest";
import {
  automationRate,
  fillDays,
  FALLBACK_CLASSIFY_USD,
  localDay,
  prefilterSavingsUsd,
  utcDayStart,
} from "../../src/modules/dashboard/dashboard-rules.js";
import { assertDemoDatabaseName, NotADemoDatabaseError } from "../../src/modules/demo/demo-seed.js";

describe("dashboard rules (phase 9)", () => {
  it("automation rate = automatic / finished; in-progress runs are left out", () => {
    expect(automationRate({ automatic: 8, neededPerson: 1, failed: 1, inProgress: 50 })).toBe(0.8);
    expect(automationRate({ automatic: 0, neededPerson: 0, failed: 0, inProgress: 3 })).toBeNull();
  });

  it("pre-filter savings use the real average classify cost, or the measured fallback", () => {
    expect(prefilterSavingsUsd(100, 0.003)).toBe(0.3);
    expect(prefilterSavingsUsd(100, null)).toBe(
      Math.round(100 * FALLBACK_CLASSIFY_USD * 10_000) / 10_000,
    );
    expect(prefilterSavingsUsd(0, 0.003)).toBe(0);
  });

  it("days are local to Montevideo (UTC-3): 01:30 UTC is still the previous day", () => {
    expect(localDay(new Date("2026-09-27T01:30:00Z"))).toBe("2026-09-26");
    expect(localDay(new Date("2026-09-27T03:30:00Z"))).toBe("2026-09-27");
  });

  it("fills missing days with the empty value, oldest first", () => {
    const now = new Date("2026-09-27T15:00:00Z");
    expect(fillDays(new Map([["2026-09-26", 4]]), 3, now, 0)).toEqual([
      { day: "2026-09-25", value: 0 },
      { day: "2026-09-26", value: 4 },
      { day: "2026-09-27", value: 0 },
    ]);
  });

  it("'today' for AI spend is the UTC day, like the spend guard", () => {
    expect(utcDayStart(new Date("2026-09-27T02:00:00Z"))).toEqual(new Date("2026-09-27T00:00:00Z"));
  });
});

describe("demo database guard", () => {
  it.each(["smartops", "smartops_test", "demo", "smartops_demo_old"])("refuses %s", (name) => {
    expect(() => assertDemoDatabaseName(name)).toThrow(NotADemoDatabaseError);
  });
  it("accepts a *_demo database", () => {
    expect(() => assertDemoDatabaseName("smartops_demo")).not.toThrow();
  });
});
