import { describe, expect, it } from "vitest";
import { isRecentlyResetDetails, recentlyResetMessage } from "../src/features/demo/reset-message";

describe("recentlyResetMessage (phase 12: one demo reset per 10 minutes for everyone)", () => {
  const now = Date.parse("2026-09-28T12:03:30Z");

  it("says how long ago it was reset and how long to wait", () => {
    expect(
      recentlyResetMessage({ lastResetAt: "2026-09-28T12:00:00Z", retryAfterSeconds: 390 }, now),
    ).toBe("La demo se reinició hace 3 min. Vas a poder reiniciarla de nuevo en 7 min.");
  });

  it("under a minute ago, and never 'in 0 min'", () => {
    expect(
      recentlyResetMessage({ lastResetAt: "2026-09-28T12:03:10Z", retryAfterSeconds: 5 }, now),
    ).toBe("La demo se reinició hace un momento. Vas a poder reiniciarla de nuevo en 1 min.");
  });

  it("only accepts the API's details shape", () => {
    expect(
      isRecentlyResetDetails({ lastResetAt: "2026-09-28T12:00:00Z", retryAfterSeconds: 1 }),
    ).toBe(true);
    expect(isRecentlyResetDetails({ lastResetAt: "ayer", retryAfterSeconds: 1 })).toBe(false);
    expect(isRecentlyResetDetails(undefined)).toBe(false);
  });
});
