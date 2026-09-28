import { describe, expect, it } from "vitest";
import { isPublicDemoAccount } from "../src/features/demo/public-account";

describe("isPublicDemoAccount (phase 12: the shared public demo operator)", () => {
  const demo = { operator: { email: "demo@ferreteria.demo" } };

  it("the demo's public operator, whatever the case or spaces", () => {
    expect(isPublicDemoAccount(demo, "demo@ferreteria.demo")).toBe(true);
    expect(isPublicDemoAccount(demo, " Demo@Ferreteria.DEMO ")).toBe(true);
  });

  it("any other account, or no demo at all (outside DEMO_MODE /demo/info answers 404 → null)", () => {
    expect(isPublicDemoAccount(demo, "admin@ferreteria.demo")).toBe(false);
    expect(isPublicDemoAccount(null, "demo@ferreteria.demo")).toBe(false);
    expect(isPublicDemoAccount(undefined, "demo@ferreteria.demo")).toBe(false);
    expect(isPublicDemoAccount(demo, null)).toBe(false);
  });
});
