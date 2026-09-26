import { Prisma } from "../../generated/prisma/client.js";
import {
  automationRate,
  fillDays,
  utcDayStart,
  prefilterSavingsUsd,
  DASHBOARD_TIME_ZONE,
} from "./dashboard-rules.js";
import type { DashboardRepository } from "./dashboard.repository.js";

/** Dashboard (phase 9 M1): period series + totals, with explicit definitions (dashboard-rules). */
export function createDashboardService(deps: {
  repository: DashboardRepository;
  budget: { totalUsd: number; dailyUsd: number };
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async get(days: number) {
      const at = now();
      const since = new Date(at.getTime() - days * 86_400_000);
      // "Today" for AI spend = the UTC day, exactly like the spend guard's daily cap.
      const todayStart = utcDayStart(at);
      const raw = await deps.repository.load(since, todayStart);
      const prefiltered = raw.prefilterByRule.reduce((sum, r) => sum + r.count, 0);
      return {
        timeZone: DASHBOARD_TIME_ZONE,
        days,
        messages: fillDays(raw.messagesByDay, days, at, 0).map(({ day, value }) => ({
          day,
          count: value,
        })),
        runs: { ...raw.runs, automationRate: automationRate(raw.runs) },
        prefilter: {
          total: prefiltered,
          byRule: raw.prefilterByRule,
          savedUsd: prefilterSavingsUsd(prefiltered, raw.avgClassifyUsd).toFixed(4),
        },
        ai: {
          byDay: fillDays(raw.aiCostByDay, days, at, new Prisma.Decimal(0)).map(
            ({ day, value }) => ({ day, usd: value }),
          ),
          totalUsd: raw.aiTotalUsd,
          todayUsd: raw.aiTodayUsd,
          budgetTotalUsd: deps.budget.totalUsd.toFixed(2),
          budgetDailyUsd: deps.budget.dailyUsd.toFixed(2),
        },
        errors: raw.errors,
        pending: raw.pending,
      };
    },
  };
}
export type DashboardService = ReturnType<typeof createDashboardService>;
