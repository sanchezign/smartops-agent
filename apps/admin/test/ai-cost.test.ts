import { describe, expect, it } from "vitest";
import { aiCostMode } from "@/features/dashboard/ai-cost";

describe("AI cost card mode (phase 14 #1)", () => {
  it("is sample data in the public demo and live everywhere else", () => {
    expect(aiCostMode({ demoMode: true, operator: { email: "a@b.c" } })).toBe("sample");
    expect(aiCostMode(null)).toBe("live");
    expect(aiCostMode(undefined)).toBe("live");
  });
});
