import type { PrismaClient } from "../../common/db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { DASHBOARD_TIME_ZONE, type RunCounts } from "./dashboard-rules.js";

/**
 * Dashboard aggregates (phase 9 M1): a handful of indexed GROUP BY queries over the period.
 * Days are grouped in the business time zone. Money stays Prisma Decimal (sent as strings).
 */

export interface DashboardRaw {
  messagesByDay: Map<string, number>;
  aiCostByDay: Map<string, Prisma.Decimal>;
  runs: RunCounts;
  prefilterByRule: { rule: string; count: number }[];
  avgClassifyUsd: number | null;
  aiTotalUsd: Prisma.Decimal;
  aiTodayUsd: Prisma.Decimal;
  errors: {
    failedWebhooks: number;
    failedDeliveries: number;
    failedRuns: number;
    failedOutbound: number;
    openIntegrationAlerts: number;
  };
  pending: { reviews: number; openAlerts: number; humanConversations: number };
}

export interface DashboardRepository {
  load(since: Date, todayStart: Date): Promise<DashboardRaw>;
}

const tz = DASHBOARD_TIME_ZONE;

export function createDashboardRepository(prisma: PrismaClient): DashboardRepository {
  return {
    async load(since, todayStart) {
      const [
        messages,
        cost,
        runs,
        prefilter,
        classify,
        total,
        today,
        failedWebhooks,
        failedDeliveries,
        failedOutbound,
        openIntegrationAlerts,
        reviews,
        openAlerts,
        humanConversations,
      ] = await Promise.all([
        prisma.$queryRaw<{ day: string; n: bigint }[]>`
          SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n
            FROM messages
           WHERE direction = 'inbound' AND created_at >= ${since}
           GROUP BY 1`,
        prisma.$queryRaw<{ day: string; usd: Prisma.Decimal }[]>`
          SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, sum(cost_usd) AS usd
            FROM ai_usages
           WHERE created_at >= ${since}
           GROUP BY 1`,
        prisma.$queryRaw<{ bucket: string; n: bigint }[]>`
          SELECT CASE
                   WHEN r.status = 'failed' THEN 'failed'
                   WHEN r.status = 'needs_review'
                        OR EXISTS (SELECT 1 FROM review_items ri WHERE ri.ingestion_run_id = r.id)
                     THEN 'neededPerson'
                   WHEN r.status IN ('classified', 'ingested') THEN 'automatic'
                   ELSE 'inProgress'
                 END AS bucket,
                 count(*) AS n
            FROM ingestion_runs r
           WHERE r.created_at >= ${since}
           GROUP BY 1`,
        prisma.$queryRaw<{ rule: string; n: bigint }[]>`
          SELECT prefilter_rule AS rule, count(*) AS n
            FROM ingestion_runs
           WHERE prefilter_rule IS NOT NULL AND created_at >= ${since}
           GROUP BY 1 ORDER BY 2 DESC`,
        prisma.$queryRaw<{ avg: Prisma.Decimal | null }[]>`
          SELECT avg(cost_usd) AS avg FROM ai_usages WHERE task = 'classify' AND status = 'ok'`,
        prisma.aiUsage.aggregate({ _sum: { costUsd: true } }),
        prisma.aiUsage.aggregate({
          _sum: { costUsd: true },
          where: { createdAt: { gte: todayStart } },
        }),
        prisma.webhookEvent.count({ where: { status: "failed", receivedAt: { gte: since } } }),
        prisma.integrationEvent.count({ where: { status: "failed", createdAt: { gte: since } } }),
        prisma.message.count({
          where: { direction: "outbound", status: "failed", createdAt: { gte: since } },
        }),
        prisma.alert.count({ where: { type: "integration_error", status: "open" } }),
        prisma.reviewItem.count({ where: { status: "pending" } }),
        prisma.alert.count({ where: { status: "open" } }),
        prisma.conversation.count({ where: { mode: "human" } }),
      ]);

      const runCounts: RunCounts = { automatic: 0, neededPerson: 0, failed: 0, inProgress: 0 };
      for (const row of runs) runCounts[row.bucket as keyof RunCounts] = Number(row.n);

      return {
        messagesByDay: new Map(messages.map((m) => [m.day, Number(m.n)])),
        aiCostByDay: new Map(cost.map((c) => [c.day, c.usd])),
        runs: runCounts,
        prefilterByRule: prefilter.map((p) => ({ rule: p.rule, count: Number(p.n) })),
        avgClassifyUsd: classify[0]?.avg ? Number(classify[0].avg) : null,
        aiTotalUsd: total._sum.costUsd ?? new Prisma.Decimal(0),
        aiTodayUsd: today._sum.costUsd ?? new Prisma.Decimal(0),
        errors: {
          failedWebhooks,
          failedDeliveries,
          failedRuns: runCounts.failed,
          failedOutbound,
          openIntegrationAlerts,
        },
        pending: { reviews, openAlerts, humanConversations },
      };
    },
  };
}
