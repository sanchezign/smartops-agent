"use client";

import { AlertOctagon, Check, CheckCircle2, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from "@/components/states";
import { Chip, RowList } from "@/components/list-row";
import { Button } from "@/components/ui/button";
import { canSeeSystem } from "@/components/layout/nav-items";
import { useAuthStore } from "@/features/auth/store";
import type { DashboardData } from "@/features/dashboard/types";
import { useDemoInfo } from "@/features/demo/hooks";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { alertText } from "../alert-text";
import { useAcknowledgeAlert, useAlerts } from "../hooks";
import type { AlertItem } from "../types";

const PERIOD_DAYS = 7;
const OPEN = new Set<AlertItem["status"]>(["open", "sent"]);

/**
 * System status (phase 15 M4, ADR-032): what is technical, for whoever runs the system — the
 * errors of the last days and the technical alerts. Not reviewed = the danger colour (never the
 * yellow, ADR-029); reviewed = grey. Admins mark them as reviewed; in the public demo the operator
 * sees it read-only (D1), and a regular operator not at all. The API does not change: this only
 * decides what the panel offers.
 */
export function SystemView() {
  const user = useAuthStore((s) => s.user);
  const demo = useDemoInfo();
  if (demo.isPending) return <LoadingState rows={3} />;
  if (!canSeeSystem(user, demo.data != null)) return <ForbiddenState />;
  return <SystemContent readOnly={user?.role !== "admin"} />;
}

function SystemContent({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations("system");
  const tPages = useTranslations("pages");
  const alerts = useAlerts("all", "technical");
  return (
    <>
      <PageHeader title={tPages("system")} description={t("description")} />
      {readOnly ? (
        <p
          role="note"
          className="mb-5 flex items-start gap-2 rounded-lg border-[1.5px] bg-muted/60 p-3 text-sm"
        >
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("readOnly")}
        </p>
      ) : null}
      <div className="flex flex-col gap-6">
        <PeriodErrors />
        <section aria-labelledby="system-alerts" className="flex flex-col gap-2">
          <h2 id="system-alerts" className="font-display text-sm">
            {t("alertsTitle")}
          </h2>
          {alerts.isPending ? (
            <LoadingState rows={3} />
          ) : alerts.isError ? (
            <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
          ) : alerts.data.items.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-8" aria-hidden />}
              title={t("empty")}
              description={t("emptyHint")}
            />
          ) : (
            <RowList aria-labelledby="system-alerts">
              {alerts.data.items.map((alert) => (
                <li key={alert.id}>
                  <TechnicalRow alert={alert} readOnly={readOnly} />
                </li>
              ))}
            </RowList>
          )}
        </section>
      </div>
    </>
  );
}

/** The errors of the last days, from the same figures as the Home (they move here in M5). */
function PeriodErrors() {
  const t = useTranslations("system");
  const { formatInt } = useFormat();
  const query = useApiQuery<DashboardData>(
    ["dashboard", PERIOD_DAYS],
    `/admin/dashboard?days=${PERIOD_DAYS}`,
  );
  if (query.isPending) return <LoadingState rows={1} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const e = query.data.errors;
  const rows = [
    ["failedWebhooks", e.failedWebhooks],
    ["failedDeliveries", e.failedDeliveries],
    ["failedRuns", e.failedRuns],
    ["failedOutbound", e.failedOutbound],
  ] as const;
  return (
    <section aria-labelledby="system-period" className="flex flex-col gap-2">
      <h2 id="system-period" className="font-display text-sm">
        {t("periodTitle", { count: PERIOD_DAYS })}
      </h2>
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {rows.map(([key, n]) => (
          <li
            key={key}
            className={cn(
              "flex min-h-16 flex-col justify-center gap-0.5 rounded-lg border-[1.5px] bg-card px-4 py-3",
              n > 0 ? "border-destructive" : "border-border",
            )}
          >
            <span className="text-sm text-muted-foreground">{t(`period.${key}`)}</span>
            <span
              className={cn(
                "font-display text-2xl tabular-nums",
                n > 0 ? "text-destructive" : "text-foreground",
              )}
            >
              {formatInt(n)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TechnicalRow({ alert, readOnly }: { alert: AlertItem; readOnly: boolean }) {
  const t = useTranslations("system");
  const tAlerts = useTranslations("alerts");
  const format = useFormat();
  const ack = useAcknowledgeAlert();
  const open = OPEN.has(alert.status);
  const text = alertText(alert, format);
  const title = text ? tAlerts(`titles.${text.key}`, text.params) : alert.title;
  return (
    <div
      className={cn(
        "flex min-h-16 flex-col gap-3 rounded-lg border-[1.5px] bg-card px-4 py-3 text-card-foreground sm:flex-row sm:items-center",
        open ? "border-destructive" : "border-border",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {open ? (
          <AlertOctagon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className={cn("font-medium break-words", !open && "text-muted-foreground")}>{title}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className={cn("font-medium", open && "text-destructive")}>
              {open ? t("notReviewed") : t("reviewed")}
            </span>
            <Chip>{tAlerts(`types.${alert.type}`)}</Chip>
            <span className="tabular-nums">{format.formatDateTime(alert.createdAt)}</span>
          </p>
        </div>
      </div>
      {open && !readOnly ? (
        <Button
          variant="outline"
          className="min-h-11 shrink-0"
          disabled={ack.isPending && ack.variables === alert.id}
          onClick={() => ack.mutate(alert.id)}
          aria-label={t("markReviewedLabel", { title })}
        >
          <Check aria-hidden /> {t("markReviewed")}
        </Button>
      ) : null}
    </div>
  );
}
