import { describe, expect, it } from "vitest";
import { isRecentlyResetDetails, recentlyResetParams } from "../src/features/demo/reset-message";

describe("recentlyResetParams (phase 12: one demo reset per 10 minutes for everyone)", () => {
  const now = Date.parse("2026-09-28T12:03:30Z");

  it("how long ago it was reset and how long to wait, in whole minutes", () => {
    expect(
      recentlyResetParams({ lastResetAt: "2026-09-28T12:00:00Z", retryAfterSeconds: 390 }, now),
    ).toEqual({ ago: 3, wait: 7 });
  });

  it("under a minute ago is 0 ('a moment ago'), and never 'in 0 min'", () => {
    expect(
      recentlyResetParams({ lastResetAt: "2026-09-28T12:03:10Z", retryAfterSeconds: 5 }, now),
    ).toEqual({ ago: 0, wait: 1 });
  });

  it("only accepts the API's details shape", () => {
    expect(
      isRecentlyResetDetails({ lastResetAt: "2026-09-28T12:00:00Z", retryAfterSeconds: 1 }),
    ).toBe(true);
    expect(isRecentlyResetDetails({ lastResetAt: "yesterday", retryAfterSeconds: 1 })).toBe(false);
    expect(isRecentlyResetDetails(undefined)).toBe(false);
  });
});
