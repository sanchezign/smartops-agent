/**
 * Dashboard definitions (pure, phase 9 M1). Kept explicit so the numbers on the panel are
 * explainable:
 * - A run was handled AUTOMATICALLY when it finished (classified or ingested) with no review
 *   item: pre-filtered chit-chat, notified queries/orders and lists applied without a person.
 * - It NEEDED A PERSON when it has review items or is waiting in needs_review.
 * - automationRate = automatic / (automatic + needed a person + failed); runs still in progress
 *   are left out. Null when there is nothing finished yet.
 * - Pre-filter savings = messages the deterministic pre-filter kept away from the LLM ×
 *   the average real cost of a classification (fallback: the cost measured in the phase 6
 *   real pass when there is no history yet).
 */

export const DASHBOARD_TIME_ZONE = "America/Montevideo";
/** Real classification cost measured in the phase 6 pass (Sonnet 5, cached prompt). */
export const FALLBACK_CLASSIFY_USD = 0.0027;

export interface RunCounts {
  automatic: number;
  neededPerson: number;
  failed: number;
  inProgress: number;
}

export function automationRate(runs: RunCounts): number | null {
  const finished = runs.automatic + runs.neededPerson + runs.failed;
  return finished === 0 ? null : runs.automatic / finished;
}

export function prefilterSavingsUsd(prefiltered: number, avgClassifyUsd: number | null): number {
  const unit = avgClassifyUsd && avgClassifyUsd > 0 ? avgClassifyUsd : FALLBACK_CLASSIFY_USD;
  return Math.round(prefiltered * unit * 10_000) / 10_000;
}

/** YYYY-MM-DD of `date` in the dashboard time zone. */
export function localDay(date: Date, timeZone = DASHBOARD_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The last `days` local days (oldest first), each with the value found or `empty`. */
export function fillDays<T>(
  rows: ReadonlyMap<string, T>,
  days: number,
  now: Date,
  empty: T,
): { day: string; value: T }[] {
  const out: { day: string; value: T }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = localDay(new Date(now.getTime() - i * 86_400_000));
    out.push({ day, value: rows.get(day) ?? empty });
  }
  return out;
}

/** Start of the current UTC day: the AI spend guard's daily budget is per UTC day (ADR-011). */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
