"use client";

import { Info, PackageMinus, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Chip, RowList, rowClass } from "@/components/list-row";
import { groupByDay, type DayLabel } from "@/lib/day-groups";
import { useFormat } from "@/lib/use-format";
import { alertText } from "../alert-text";
import { useAlerts } from "../hooks";
import type { AlertItem } from "../types";

/**
 * Activity (phase 15 M4, ADR-032): news about what the system already did — prices applied, low
 * stock — grouped by day. Nothing here waits for a person: no yellow, no "mark as seen" (the rows
 * stay "open" in the database and nothing counts them, see dashboard.repository.ts).
 */
export function ActivityView() {
  const query = useAlerts("all", "info");
  const t = useTranslations("activity");
  const tPages = useTranslations("pages");
  return (
    <>
      <PageHeader title={tPages("activity")} description={t("description")} />
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ActivityDays items={query.data.items} />
      )}
    </>
  );
}

function ActivityDays({ items }: { items: AlertItem[] }) {
  const t = useTranslations("activity");
  const { formatLongDay } = useFormat();
  const dayName = (label: DayLabel) =>
    label.kind === "date" ? formatLongDay(label.at) : t(label.kind);
  return (
    <div className="flex flex-col gap-6">
      {groupByDay(items, (a) => a.createdAt).map((group) => {
        const id = `activity-${group.day}`;
        return (
          <section key={group.day} aria-labelledby={id} className="flex flex-col gap-2">
            <h2 id={id} className="font-display text-sm first-letter:uppercase">
              {dayName(group.label)}
            </h2>
            <RowList aria-labelledby={id}>
              {group.items.map((alert) => (
                <li key={alert.id}>
                  <NewsRow alert={alert} />
                </li>
              ))}
            </RowList>
          </section>
        );
      })}
    </div>
  );
}

/** One news item: what happened, when, and where to see it. Never a button. */
function NewsRow({ alert }: { alert: AlertItem }) {
  const t = useTranslations("activity");
  const tAlerts = useTranslations("alerts");
  const format = useFormat();
  const text = alertText(alert, format);
  const title = text ? tAlerts(`titles.${text.key}`, text.params) : alert.title;
  const pct = typeof alert.details?.changePct === "string" ? Number(alert.details.changePct) : 0;
  const Icon =
    alert.type === "price_change"
      ? pct < 0
        ? TrendingDown
        : TrendingUp
      : alert.type === "low_stock"
        ? PackageMinus
        : Info;
  return (
    <div className={rowClass(false, false)}>
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium break-words">{title}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <Chip>{tAlerts(`types.${alert.type}`)}</Chip>
          <span className="tabular-nums">{format.formatTime(alert.createdAt)}</span>
          {alert.product ? (
            <Link
              href={`/catalog/${alert.product.id}`}
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            >
              {t("viewProduct")}
            </Link>
          ) : alert.conversationId ? (
            <Link
              href={`/conversations/${alert.conversationId}`}
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            >
              {t("viewConversation")}
            </Link>
          ) : null}
        </p>
      </div>
    </div>
  );
}
