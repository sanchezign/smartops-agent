"use client";

import {
  AlertTriangle,
  Bot,
  ClipboardCheck,
  Filter,
  MessageSquare,
  UserRound,
  Wallet,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDemoInfo } from "@/features/demo/hooks";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";
import { isPrefilterRule, type DashboardData } from "../types";
import { aiCostMode } from "../ai-cost";
import { DailyBars } from "./daily-bars";
import { StatCard } from "./stat-card";

const PERIODS = [7, 14, 30] as const;

export function DashboardView() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(14);
  const query = useApiQuery<DashboardData>(["dashboard", days], `/admin/dashboard?days=${days}`);
  const t = useTranslations("dashboard");
  const tPages = useTranslations("pages");

  return (
    <>
      <PageHeader
        title={tPages("home")}
        description={t("description")}
        actions={
          <div role="group" aria-label={t("period")} className="inline-flex rounded-lg border p-1">
            {PERIODS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={days === p ? "secondary" : "ghost"}
                aria-pressed={days === p}
                onClick={() => setDays(p)}
                className="min-h-9"
              >
                {t("days", { count: p })}
              </Button>
            ))}
          </div>
        }
      />
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <DashboardContent data={query.data} />
      )}
    </>
  );
}

function DashboardContent({ data }: { data: DashboardData }) {
  const t = useTranslations("dashboard");
  const { formatInt, formatNumber, formatRatio, formatUsd, formatUsdPrecise } = useFormat();
  const costMode = aiCostMode(useDemoInfo().data);
  const messages = data.messages.reduce((sum, d) => sum + d.count, 0);
  const errors =
    data.errors.failedWebhooks +
    data.errors.failedDeliveries +
    data.errors.failedRuns +
    data.errors.failedOutbound;
  const finished = data.runs.automatic + data.runs.neededPerson + data.runs.failed;

  return (
    <div className="flex flex-col gap-4">
      {/* What needs a person now */}
      <section aria-labelledby="home-pending" className="flex flex-col gap-2">
        <h2 id="home-pending" className="font-display text-sm">
          {t("pendingSection")}
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCard
            label={t("pendingReviews")}
            value={formatInt(data.pending.reviews)}
            icon={ClipboardCheck}
            href="/reviews"
            tone={data.pending.reviews > 0 ? "attention" : "default"}
          />
          <StatCard
            label={t("openAlerts")}
            value={formatInt(data.pending.openAlerts)}
            icon={AlertTriangle}
            href="/alerts"
            tone={data.pending.openAlerts > 0 ? "attention" : "default"}
          />
          <StatCard
            label={t("humanChats")}
            value={formatInt(data.pending.humanConversations)}
            icon={UserRound}
            href="/conversations"
            tone={data.pending.humanConversations > 0 ? "attention" : "default"}
          />
          <StatCard
            label={t("periodErrors")}
            value={formatInt(errors)}
            hint={
              data.errors.openIntegrationAlerts > 0
                ? t("integrationUnreviewed", {
                    count: formatInt(data.errors.openIntegrationAlerts),
                  })
                : t("errorSources")
            }
            icon={AlertTriangle}
            tone={errors > 0 ? "danger" : "default"}
          />
        </div>
      </section>

      <section aria-labelledby="home-automation" className="flex flex-col gap-2">
        <h2 id="home-automation" className="font-display text-sm">
          {t("automationSection")}
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
          <StatCard
            label={t("messagesReceived")}
            value={formatInt(messages)}
            hint={t("lastDays", { count: data.days })}
            icon={MessageSquare}
          />
          <StatCard
            label={t("resolvedAlone")}
            value={formatRatio(data.runs.automationRate)}
            hint={
              finished > 0
                ? t("resolvedOf", {
                    automatic: formatInt(data.runs.automatic),
                    finished: formatInt(finished),
                  })
                : t("nothingProcessed")
            }
            icon={Bot}
          />
          <StatCard
            label={t("filteredNoAi")}
            value={formatInt(data.prefilter.total)}
            hint={t("estimatedSaving", { amount: formatUsd(data.prefilter.savedUsd) })}
            icon={Filter}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("messagesPerDay")}</h2>
            </CardTitle>
            <CardDescription>{t("messagesPerDayHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyBars
              label={t("messagesLabel")}
              color="var(--chart-1)"
              data={data.messages.map((d) => ({ day: d.day, value: d.count }))}
              format={(v) => formatInt(v)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="flex flex-wrap items-center gap-2">
                {t("aiCostPerDay")}
                {costMode === "sample" ? <Badge variant="outline">{t("sampleData")}</Badge> : null}
              </h2>
            </CardTitle>
            <CardDescription>
              {costMode === "sample"
                ? t("sampleDataHint")
                : t("aiCostSummary", {
                    today: formatUsd(data.ai.todayUsd),
                    dailyBudget: formatUsd(data.ai.budgetDailyUsd),
                    total: formatUsd(data.ai.totalUsd),
                    totalBudget: formatUsd(data.ai.budgetTotalUsd),
                  })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyBars
              label={t("aiCostLabel")}
              color="var(--chart-2)"
              data={data.ai.byDay.map((d) => ({ day: d.day, value: Number(d.usd) }))}
              format={(v) => formatUsdPrecise(v.toFixed(4))}
              axisFormat={(v) => formatNumber(v, { maximumFractionDigits: 3 })}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex items-center gap-2">
              <Wallet className="size-4" aria-hidden /> {t("prefilterTitle")}
            </h2>
          </CardTitle>
          <CardDescription>{t("prefilterHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.prefilter.byRule.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("prefilterEmpty")}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {data.prefilter.byRule.map((r) => (
                <li
                  key={r.rule}
                  className="flex min-h-11 items-center justify-between gap-3 text-sm"
                >
                  <span>{isPrefilterRule(r.rule) ? t(`prefilterRules.${r.rule}`) : r.rule}</span>
                  <span className="font-medium tabular-nums">{formatInt(r.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
