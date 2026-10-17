"use client";

import {
  AlertOctagon,
  Bot,
  CheckCircle2,
  ChevronRight,
  Filter,
  MessageSquare,
  Mic,
  UserRound,
  UserX,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { RowList, WAITS_LINE } from "@/components/list-row";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { cn } from "@/lib/utils";
import { alertText } from "@/features/catalog/alert-text";
import { useDemoInfo } from "@/features/demo/hooks";
import { QuestionText } from "@/features/reviews/components/question-text";
import { reviewQuestion } from "@/features/reviews/question";
import { sourceKind } from "@/features/reviews/source";
import { SourceIcon } from "@/features/reviews/source-icon";
import { useTodo } from "@/features/todo/hooks";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";
import { isPrefilterRule, type DashboardData } from "../types";
import { aiCostMode } from "../ai-cost";
import { firstTasks, type Task } from "../first-tasks";
import { DailyBars } from "./daily-bars";
import { StatCard } from "./stat-card";

const PERIODS = [7, 14, 30] as const;

/**
 * Home (phase 15 M5, ADR-032): first what waits for THIS person — the first decisions, or "All
 * caught up" — then the chats a person is handling and, for admins, unreviewed technical errors
 * (one red line, never yellow); then the value of the period (messages, automation, pre-filter)
 * with its own period switch; the charts and the pre-filter list last.
 */
export function DashboardView() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(14);
  const query = useApiQuery<DashboardData>(["dashboard", days], `/admin/dashboard?days=${days}`);
  const tPages = useTranslations("pages");
  const t = useTranslations("dashboard");
  return (
    <>
      <PageHeader title={tPages("home")} description={t("description")} />
      <div className="flex flex-col gap-6">
        <PendingBlock />
        {query.data ? <AttentionLines data={query.data} /> : null}
        {query.isPending ? (
          <LoadingState rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <PeriodContent data={query.data} days={days} onDays={setDays} />
        )}
      </div>
    </>
  );
}

function PendingBlock() {
  const t = useTranslations("dashboard");
  const { formatInt } = useFormat();
  const todo = useTodo();
  return (
    <section aria-labelledby="home-pending" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="home-pending" className="font-display text-sm">
          {t("pendingTitle")}
        </h2>
        {todo.data && todo.data.counts.total > 0 ? (
          <Link
            href="/todo"
            className="flex min-h-11 items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("seeAll", { count: formatInt(todo.data.counts.total) })}
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      {todo.isPending ? (
        <LoadingState rows={2} />
      ) : todo.isError ? (
        <ErrorState error={todo.error} onRetry={() => void todo.refetch()} />
      ) : todo.data.counts.total === 0 ? (
        <p className="flex min-h-12 items-center gap-2 rounded-lg border-[1.5px] border-dashed px-4 py-3 text-sm">
          <CheckCircle2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <strong className="font-medium">{t("caughtUpTitle")}</strong> {t("caughtUpHint")}
          </span>
        </p>
      ) : (
        <RowList aria-labelledby="home-pending">
          {firstTasks(todo.data).map((task) => (
            <li key={task.kind === "review" ? task.item.id : task.alert.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </RowList>
      )}
    </section>
  );
}

/** One decision, light: what is asked and where, as a link (deciding happens in To do). */
function TaskRow({ task }: { task: Task }) {
  const tAlerts = useTranslations("alerts");
  const tTodo = useTranslations("todo");
  const format = useFormat();
  let href: string;
  let title: ReactNode;
  let detail: string;
  let icon: ReactNode;
  if (task.kind === "review") {
    const question = reviewQuestion(task.item, format);
    href = `/reviews/${task.item.id}`;
    title = <QuestionText question={question} />;
    detail = task.item.supplier?.name ?? tTodo("unknownSupplier");
    icon = <SourceIcon kind={sourceKind(task.item.message)} className="size-5 shrink-0" />;
  } else {
    const text = alertText({ ...task.alert, product: null }, format);
    href = "/todo";
    title = text ? tAlerts(`titles.${text.key}`, text.params) : task.alert.title;
    detail = tAlerts(`types.${task.alert.type}`);
    const Icon = task.alert.type === "possible_opt_out" ? UserX : Mic;
    icon = <Icon className="size-5 shrink-0" aria-hidden />;
  }
  return (
    <Link
      href={href}
      className="flex min-h-14 items-center gap-3 rounded-lg border-[1.5px] border-foreground bg-card px-4 py-2.5 text-card-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* A review question carries its own emphasis (its values); an alert title stays medium. */}
        <span className={cn("text-sm break-words", task.kind !== "review" && "font-medium")}>
          {title}
        </span>
        <span className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span
            className={cn(
              "truncate",
              task.kind === "review" && "font-semibold text-foreground", // the supplier (ADR-033 §7)
            )}
          >
            {detail}
          </span>
          {/* It waits for a person: the yellow line of To do (ADR-033 §4); not a link of its own (the row is). */}
          <span className={cn("tabular-nums", WAITS_LINE)}>{format.formatRelative(task.at)}</span>
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

/**
 * Lines that only appear when there is something: the chats a person is handling, and — admins
 * only — unreviewed technical errors (the danger colour, never yellow; ADR-032 D2).
 */
function AttentionLines({ data }: { data: DashboardData }) {
  const t = useTranslations("dashboard");
  const { formatInt } = useFormat();
  const admin = useAuthStore((s) => s.user)?.role === "admin";
  const chats = data.pending.humanConversations;
  const errors = data.errors.openIntegrationAlerts;
  if (chats === 0 && !(admin && errors > 0)) return null;
  return (
    <div className="flex flex-col gap-2">
      {admin && errors > 0 ? (
        <Link
          href="/system"
          className="flex min-h-12 items-center gap-2 rounded-lg border-[1.5px] border-destructive bg-card px-4 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
        >
          <AlertOctagon className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">
            {t("systemErrors", { count: errors, n: formatInt(errors) })}
          </span>
          <span className="underline underline-offset-4">{t("systemLink")}</span>
        </Link>
      ) : null}
      {chats > 0 ? (
        <Link
          href="/conversations"
          className="flex min-h-12 items-center gap-2 rounded-lg border-[1.5px] bg-card px-4 py-2.5 text-sm transition-colors hover:border-foreground"
        >
          <UserRound className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">
            {t("humanChatsLine", { count: chats, n: formatInt(chats) })}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

function PeriodContent({
  data,
  days,
  onDays,
}: {
  data: DashboardData;
  days: (typeof PERIODS)[number];
  onDays(days: (typeof PERIODS)[number]): void;
}) {
  const t = useTranslations("dashboard");
  const { formatInt, formatNumber, formatRatio, formatUsd, formatUsdPrecise } = useFormat();
  const costMode = aiCostMode(useDemoInfo().data);
  const messages = data.messages.reduce((sum, d) => sum + d.count, 0);
  const finished = data.runs.automatic + data.runs.neededPerson + data.runs.failed;

  return (
    <>
      <section aria-labelledby="home-automation" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="home-automation" className="font-display text-sm">
            {t("automationSection")}
          </h2>
          <div
            role="group"
            aria-label={t("period")}
            className="inline-flex rounded-lg border-[1.5px] p-1"
          >
            {PERIODS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={days === p ? "secondary" : "ghost"}
                aria-pressed={days === p}
                onClick={() => onDays(p)}
                className="min-h-9"
              >
                {t("days", { count: p })}
              </Button>
            ))}
          </div>
        </div>
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
    </>
  );
}
