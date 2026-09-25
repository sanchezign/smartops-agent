/**
 * AI spend guard (pure). The project runs on ~5 USD of Claude credits: every call is
 * checked BEFORE it is made against the total budget, the daily budget and a per-contact
 * daily extraction limit (ADR-011).
 */

export interface BudgetLimits {
  totalUsd: number;
  dailyUsd: number;
  dailyExtractionsPerContact: number;
}

export interface SpendSnapshot {
  spentTotalUsd: number;
  spentTodayUsd: number;
  /** Extractions already made today for this contact (null when no contact). */
  contactExtractionsToday: number | null;
}

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "total_budget_exceeded" | "daily_budget_exceeded" | "contact_daily_limit";
      detail: string;
    };

export function checkBudget(
  limits: BudgetLimits,
  spend: SpendSnapshot,
  call: { estimatedCostUsd: number; isExtraction: boolean },
): BudgetDecision {
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  if (spend.spentTotalUsd + call.estimatedCostUsd > limits.totalUsd) {
    return {
      allowed: false,
      reason: "total_budget_exceeded",
      detail: `spent ${fmt(spend.spentTotalUsd)} + estimated ${fmt(call.estimatedCostUsd)} > total ${fmt(limits.totalUsd)}`,
    };
  }
  if (spend.spentTodayUsd + call.estimatedCostUsd > limits.dailyUsd) {
    return {
      allowed: false,
      reason: "daily_budget_exceeded",
      detail: `spent today ${fmt(spend.spentTodayUsd)} + estimated ${fmt(call.estimatedCostUsd)} > daily ${fmt(limits.dailyUsd)}`,
    };
  }
  if (
    call.isExtraction &&
    spend.contactExtractionsToday !== null &&
    spend.contactExtractionsToday >= limits.dailyExtractionsPerContact
  ) {
    return {
      allowed: false,
      reason: "contact_daily_limit",
      detail: `${spend.contactExtractionsToday} extractions today for this contact (limit ${limits.dailyExtractionsPerContact})`,
    };
  }
  return { allowed: true };
}

/** Start of the current UTC day (budgets reset at 00:00 UTC). */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
