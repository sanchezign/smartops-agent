"use client";

import { CheckCircle2, ChevronRight, History, Lock, Mic, UserX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Chip, RowList } from "@/components/list-row";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { alertText } from "@/features/catalog/alert-text";
import { useAcknowledgeAlert } from "@/features/catalog/hooks";
import { useDemoInfo } from "@/features/demo/hooks";
import { reviewTitle } from "@/features/reviews/labels";
import { canResolve } from "@/features/reviews/permissions";
import { listOrder, sourceKind } from "@/features/reviews/source";
import { SourceIcon } from "@/features/reviews/source-icon";
import type { ReviewItem } from "@/features/reviews/types";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useListReviews, useTodo } from "../hooks";
import type { TodoAlert, TodoGroup, TodoView as TodoData } from "../types";

/**
 * To do (phase 15, ADR-032): everything that waits for a person, in one place — the lists the
 * system did not apply on its own (one card per message) and the messages to check. What only an
 * admin can resolve is folded away, without yellow (ADR-029: the nav counter is the yellow).
 */
export function TodoView() {
  const query = useTodo();
  const t = useTranslations("todo");
  const tPages = useTranslations("pages");
  return (
    <>
      <PageHeader
        title={tPages("todo")}
        description={t("description")}
        actions={
          <Button asChild variant="outline" size="sm" className="min-h-11">
            <Link href="/todo/resolved">
              <History aria-hidden /> {t("resolvedLink")}
            </Link>
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <TodoContent data={query.data} />
      )}
    </>
  );
}

function TodoContent({ data }: { data: TodoData }) {
  const t = useTranslations("todo");
  const { formatInt } = useFormat();
  const mine = data.groups.filter((g) => g.reviews.canResolve > 0);
  const theirs = data.groups.filter((g) => g.reviews.canResolve === 0);
  const waiting = data.counts.reviews.waitingForAdmin;

  return (
    <div className="flex flex-col gap-6">
      {data.counts.total === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="size-8" aria-hidden />}
          title={t("emptyTitle")}
          description={t("emptyHint")}
        />
      ) : null}

      {mine.length > 0 ? (
        <section aria-labelledby="todo-lists" className="flex flex-col gap-2">
          <h2 id="todo-lists" className="font-display text-sm">
            {t("listsTitle")}
          </h2>
          <RowList aria-labelledby="todo-lists">
            {mine.map((group) => (
              <li key={group.run.id}>
                <ListCard group={group} />
              </li>
            ))}
          </RowList>
        </section>
      ) : null}

      {data.alerts.length > 0 ? (
        <section aria-labelledby="todo-messages" className="flex flex-col gap-2">
          <h2 id="todo-messages" className="font-display text-sm">
            {t("messagesTitle")}
          </h2>
          <RowList aria-labelledby="todo-messages">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <AlertRow alert={alert} />
              </li>
            ))}
          </RowList>
        </section>
      ) : null}

      {data.groupsTruncated ? (
        <p className="text-sm text-muted-foreground">
          {t("truncated", { count: formatInt(data.groups.length) })}
        </p>
      ) : null}

      {waiting > 0 ? (
        <details className="group rounded-lg border-[1.5px] border-dashed bg-card/50">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-4 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden
            />
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t("waitingTitle", { count: formatInt(waiting) })}
          </summary>
          <div className="flex flex-col gap-3 px-4 pb-4">
            <p className="text-sm text-muted-foreground">{t("waitingWhy")}</p>
            <RowList>
              {theirs.map((group) => (
                <li key={group.run.id}>
                  <ListCard group={group} />
                </li>
              ))}
            </RowList>
            {mine.some((g) => g.reviews.waitingForAdmin > 0) ? (
              <p className="text-sm text-muted-foreground">{t("waitingInLists")}</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** One list (one message): where it came from, when, how many decisions, its first items. */
function ListCard({ group }: { group: TodoGroup }) {
  const t = useTranslations("todo");
  const { formatInt, formatRelative } = useFormat();
  const [all, setAll] = useState(false);
  const more = group.pending > group.items.length;
  const full = useListReviews(group.run.id, all && more);
  const items = all && full.data ? listOrder(full.data.items) : group.items;
  const kind = sourceKind(group.message);
  const mine = group.reviews.canResolve > 0;
  return (
    <article
      aria-label={group.supplier?.name ?? t("unknownSupplier")}
      className={cn(
        "flex flex-col gap-3 rounded-lg border-[1.5px] bg-card p-4 text-card-foreground",
        mine ? "border-foreground" : "border-border",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SourceIcon kind={kind} className="size-5 shrink-0" />
        <h3 className="font-medium">{group.supplier?.name ?? t("unknownSupplier")}</h3>
        <Chip>{t(`source.${kind}`)}</Chip>
        <span className="text-sm text-muted-foreground tabular-nums">
          {formatRelative(group.message.receivedAt)}
        </span>
        <span className="ml-auto text-sm font-medium tabular-nums">
          {t("pendingInList", { count: group.pending, n: formatInt(group.pending) })}
        </span>
      </header>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <ItemLink item={item} />
          </li>
        ))}
      </ul>
      {more ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 w-fit"
          aria-expanded={all}
          disabled={all && full.isPending}
          onClick={() => setAll((v) => !v)}
        >
          {all ? t("showFewer") : t("viewAll", { count: formatInt(group.pending) })}
        </Button>
      ) : null}
    </article>
  );
}

/** One decision inside a list: what is asked and about what; a lock when it is not mine. */
function ItemLink({ item }: { item: ReviewItem }) {
  const tReviews = useTranslations("reviews");
  const t = useTranslations("todo");
  const user = useAuthStore((s) => s.user);
  const demoMode = useDemoInfo().data != null; // ADR-030
  const { formatPct } = useFormat();
  const locked = !canResolve(user, item, { demoMode });
  const title = reviewTitle(item, {
    line: tReviews("titles.line"),
    product: tReviews("titles.product"),
    message: tReviews("titles.message"),
    globalChange: (pct, count) =>
      tReviews("titles.globalChange", {
        pct: pct ? formatPct(pct) : tReviews("titles.change"),
        count,
      }),
  });
  return (
    <Link
      href={`/reviews/${item.id}`}
      className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{tReviews(`kinds.${item.kind}`)}</span>
        <span className="truncate text-sm text-muted-foreground">{title}</span>
      </span>
      {locked ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Lock className="size-3.5" aria-hidden />
          {t("adminResolves")}
        </span>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

/** A message to check by hand (ADR-032 action alerts): what, when, the chat, and "done". */
function AlertRow({ alert }: { alert: TodoAlert }) {
  const t = useTranslations("todo");
  const tAlerts = useTranslations("alerts");
  const format = useFormat();
  const ack = useAcknowledgeAlert();
  const text = alertText({ ...alert, product: null }, format);
  const title = text ? tAlerts(`titles.${text.key}`, text.params) : alert.title;
  const Icon = alert.type === "possible_opt_out" ? UserX : Mic;
  const label = alert.type === "possible_opt_out" ? t("notOptOut") : t("done");
  return (
    <div className="flex min-h-16 flex-col gap-3 rounded-lg border-[1.5px] border-foreground bg-card px-4 py-3 text-card-foreground sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium break-words">{title}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Chip>{tAlerts(`types.${alert.type}`)}</Chip>
            <span className="tabular-nums">{format.formatRelative(alert.createdAt)}</span>
            {alert.conversationId ? (
              <Link
                href={`/conversations/${alert.conversationId}`}
                className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
              >
                {alert.type === "manual_attention" ? t("listenInChat") : t("openChat")}
              </Link>
            ) : null}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        className="min-h-11 shrink-0"
        disabled={ack.isPending && ack.variables === alert.id}
        onClick={() => ack.mutate(alert.id)}
        aria-label={t("ackLabel", { action: label, title })}
      >
        {label}
      </Button>
    </div>
  );
}
