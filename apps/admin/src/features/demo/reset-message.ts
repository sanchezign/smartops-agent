/**
 * "Reset demo" refused because somebody reset it a few minutes ago (phase 12: one reset per
 * 10 minutes for every visitor). The API answers 429 DEMO_RECENTLY_RESET with the time of the
 * last reset and how long to wait; this turns it into the numbers of the "demo.toast.recentlyReset"
 * message (phase 13: the words live in the catalogs).
 */
export interface RecentlyResetDetails {
  lastResetAt: string;
  retryAfterSeconds: number;
}

export function isRecentlyResetDetails(value: unknown): value is RecentlyResetDetails {
  const v = value as Partial<RecentlyResetDetails> | null;
  return (
    typeof v?.lastResetAt === "string" &&
    !Number.isNaN(Date.parse(v.lastResetAt)) &&
    typeof v.retryAfterSeconds === "number"
  );
}

/** Whole minutes since the reset (0 = "a moment ago") and to wait (never "in 0 min"). */
export function recentlyResetParams(
  details: RecentlyResetDetails,
  now = Date.now(),
): { ago: number; wait: number } {
  return {
    ago: Math.max(0, Math.floor((now - Date.parse(details.lastResetAt)) / 60_000)),
    wait: Math.max(1, Math.ceil(details.retryAfterSeconds / 60)),
  };
}
