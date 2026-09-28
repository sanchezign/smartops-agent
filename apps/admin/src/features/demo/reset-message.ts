/**
 * "Reiniciar demo" refused because somebody reset it a few minutes ago (phase 12: one reset per
 * 10 minutes for every visitor). The API answers 429 DEMO_RECENTLY_RESET with the time of the
 * last reset and how long to wait; this turns it into the sentence the panel shows.
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

export function recentlyResetMessage(details: RecentlyResetDetails, now = Date.now()): string {
  const agoMinutes = Math.floor((now - Date.parse(details.lastResetAt)) / 60_000);
  const ago = agoMinutes < 1 ? "hace un momento" : `hace ${agoMinutes} min`;
  const wait = Math.max(1, Math.ceil(details.retryAfterSeconds / 60));
  return `La demo se reinició ${ago}. Vas a poder reiniciarla de nuevo en ${wait} min.`;
}
