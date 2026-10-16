import { describe, expect, it } from "vitest";
import { adminOnlyOutsideDemo, canResolve } from "../src/features/reviews/permissions";

/** ADR-034 (phase 16 M2): the panel's note "In a real installation an administrator resolves this". */
const operator = { role: "operator" } as never;
const admin = { role: "admin" } as never;
const gate = { scope: "run", kind: "suspicious_instructions" } as const;
const catalog = { scope: "catalog", kind: "global_change" } as const;
const line = { scope: "line", kind: "price_outlier" } as const;

describe("adminOnlyOutsideDemo", () => {
  it("in the demo, an operator sees the note on run gates and catalog-wide reviews only", () => {
    expect(adminOnlyOutsideDemo(operator, gate, { demoMode: true })).toBe(true);
    expect(adminOnlyOutsideDemo(operator, catalog, { demoMode: true })).toBe(true);
    expect(adminOnlyOutsideDemo(operator, line, { demoMode: true })).toBe(false);
  });
  it("never outside the demo, never for an admin, never without a session", () => {
    for (const item of [gate, catalog, line]) {
      expect(adminOnlyOutsideDemo(operator, item, { demoMode: false })).toBe(false);
      expect(adminOnlyOutsideDemo(operator, item)).toBe(false);
      expect(adminOnlyOutsideDemo(admin, item, { demoMode: true })).toBe(false);
      expect(adminOnlyOutsideDemo(null, item, { demoMode: true })).toBe(false);
    }
  });
  it("whenever the note shows, the operator CAN resolve it in the demo (no dead button)", () => {
    for (const item of [gate, catalog])
      expect(canResolve(operator, item, { demoMode: true })).toBe(true);
  });
});
