/** GET /api/v1/admin/dashboard (phase 9 M1). Money = Decimal strings. */
export interface DashboardData {
  timeZone: string;
  days: number;
  messages: { day: string; count: number }[];
  runs: {
    automatic: number;
    neededPerson: number;
    failed: number;
    inProgress: number;
    automationRate: number | null;
  };
  prefilter: { total: number; byRule: { rule: string; count: number }[]; savedUsd: string };
  ai: {
    byDay: { day: string; usd: string }[];
    totalUsd: string;
    todayUsd: string;
    budgetTotalUsd: string;
    budgetDailyUsd: string;
  };
  errors: {
    failedWebhooks: number;
    failedDeliveries: number;
    failedRuns: number;
    failedOutbound: number;
    openIntegrationAlerts: number;
  };
  pending: { reviews: number; openAlerts: number; humanConversations: number };
}

/** Why a message never reached the LLM (pre-filter rules, phase 6; texts in the catalogs). */
export const PREFILTER_RULES = [
  "no_price_signal",
  "customer_contact",
  "non_content_type",
  "media_unavailable",
  "audio_too_long",
  "audio_not_transcribed",
] as const;
export type PrefilterRule = (typeof PREFILTER_RULES)[number];

export function isPrefilterRule(value: string): value is PrefilterRule {
  return (PREFILTER_RULES as readonly string[]).includes(value);
}
