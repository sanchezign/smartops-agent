"use client";

import { CheckCircle2, ChevronRight, History, Lock, Mic, UserX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Chip, RowList } from "@/components/list-row";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { alertText } from "@/features/catalog/alert-text";
import { useAcknowledgeAlert } from "@/features/catalog/hooks";
import { useDemoInfo } from "@/features/demo/hooks";
import { resolveErrorKey } from "@/features/reviews/hooks";
import { ResetDemoButton } from "@/features/demo/components/reset-demo-button";
import { adminOnlyOutsideDemo, canResolve } from "@/features/reviews/permissions";
import { reviewQuestion } from "@/features/reviews/question";
import { quickDecision, type Money, type QuickDecision } from "@/features/reviews/quick-decision";
import { listOrder, sourceKind } from "@/features/reviews/source";
import { SourceIcon } from "@/features/reviews/source-icon";
import type { ReviewItem } from "@/features/reviews/types";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useListReviews, useOptOutFromTodo, useQuickDecision, useTodo } from "../hooks";
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
  const tPages = useTranslations("pages");
  // ADR-034 (D14): in the public demo, an empty To do points to what brings decisions back.
  const demo = useDemoInfo().data != null;
  const { formatInt } = useFormat();
  const [waitingOpen, setWaitingOpen] = useState(false);
  // Each review lives in ONE place (owner, M2 review): what I can resolve on the cards above,
  // what only an admin can resolve in the folded section, grouped by list the same way.
  const mine = data.groups.filter((g) => g.reviews.canResolve > 0);
  const theirs = data.groups.filter((g) => g.reviews.waitingForAdmin > 0);
  const waiting = data.counts.reviews.waitingForAdmin;
  const openWaiting = () => {
    setWaitingOpen(true);
    requestAnimationFrame(() =>
      document.getElementById(WAITING_ID)?.scrollIntoView({ block: "start" }),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {data.counts.total === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="size-8" aria-hidden />}
          title={t("emptyTitle")}
          description={demo ? t("demoEmptyHint") : t("emptyHint")}
          action={
            demo ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild className="min-h-11">
                  <Link href="/try">{tPages("try")}</Link>
                </Button>
                <ResetDemoButton />
              </div>
            ) : undefined
          }
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
                <ListCard group={group} onShowWaiting={openWaiting} />
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
        <details
          id={WAITING_ID}
          open={waitingOpen}
          onToggle={(e) => setWaitingOpen(e.currentTarget.open)}
          className="group scroll-mt-20 rounded-lg border-[1.5px] border-dashed bg-card/50"
        >
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
            <RowList aria-label={t("waitingListLabel")}>
              {theirs.map((group) => (
                <li key={group.run.id}>
                  <ListCard group={group} waiting />
                </li>
              ))}
            </RowList>
          </div>
        </details>
      ) : null}
    </div>
  );
}

const WAITING_ID = "todo-waiting";

/**
 * One list (one message) for one owner: the decisions THIS user can make, or (`waiting`) the
 * ones only an admin can make. Its count is the count of what it shows.
 */
function ListCard({
  group,
  waiting = false,
  onShowWaiting,
}: {
  group: TodoGroup;
  waiting?: boolean;
  onShowWaiting?: () => void;
}) {
  const t = useTranslations("todo");
  const user = useAuthStore((s) => s.user);
  const demoMode = useDemoInfo().data != null; // ADR-030
  const { formatInt, formatRelative } = useFormat();
  const [all, setAll] = useState(false);
  const count = waiting ? group.reviews.waitingForAdmin : group.reviews.canResolve;
  const firstItems = waiting ? group.waitingItems : group.items;
  const more = count > firstItems.length;
  const full = useListReviews(group.run.id, all && more);
  const items =
    all && full.data
      ? listOrder(full.data.items).filter((i) => canResolve(user, i, { demoMode }) !== waiting)
      : firstItems;
  const kind = sourceKind(group.message);
  const name = group.supplier?.name ?? t("unknownSupplier");
  const alsoWaiting = waiting ? 0 : group.reviews.waitingForAdmin;
  return (
    <article
      aria-label={name}
      className={cn(
        "flex flex-col gap-3 rounded-lg border-[1.5px] bg-card p-4 text-card-foreground",
        waiting ? "border-border" : "border-foreground",
      )}
    >
      <header className="flex items-start gap-3">
        <SourceIcon kind={kind} className="mt-0.5 size-5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium break-words">{name}</h3>
          {/* One meta line (owner, M2 review): kind · when · how many — never a count alone. */}
          <p className="text-sm text-muted-foreground tabular-nums">
            {t("cardMeta", {
              source: t(`source.${kind}`),
              when: formatRelative(group.message.receivedAt),
              pending: t("pendingInList", { count, n: formatInt(count) }),
            })}
          </p>
        </div>
      </header>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <ItemRow item={item} />
          </li>
        ))}
      </ul>
      {more || alsoWaiting > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {more ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 w-fit"
              aria-expanded={all}
              disabled={all && full.isPending}
              onClick={() => setAll((v) => !v)}
            >
              {all ? t("showFewer") : t("viewAll", { count: formatInt(count) })}
            </Button>
          ) : null}
          {alsoWaiting > 0 ? (
            <a
              href={`#${WAITING_ID}`}
              onClick={(e) => {
                e.preventDefault();
                onShowWaiting?.();
              }}
              className="flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              <Lock className="size-3.5" aria-hidden />
              {t("alsoWaiting", { count: alsoWaiting, n: formatInt(alsoWaiting) })}
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * One decision inside a list, as a question (phase 15 M3): the question links to the detail; when
 * approving needs no choice (quick-decision.ts) two buttons decide it here, each with a concrete
 * verb and the value — never "Yes / No".
 */
function ItemRow({ item }: { item: ReviewItem }) {
  const tReviews = useTranslations("reviews");
  const format = useFormat();
  const user = useAuthStore((s) => s.user);
  const demoMode = useDemoInfo().data != null; // ADR-030, ADR-034
  const quick = quickDecision(item, { canResolve: canResolve(user, item, { demoMode }) });
  const question = reviewQuestion(item, format);
  const realAdminOnly = adminOnlyOutsideDemo(user, item, { demoMode });
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <Link
        href={`/reviews/${item.id}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium break-words">
            {tReviews(`questions.${question.key}`, question.params)}
          </span>
          <span className="text-sm text-muted-foreground">{tReviews(`kinds.${item.kind}`)}</span>
          {realAdminOnly ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {tReviews("realAdminOnly")}
            </span>
          ) : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      {quick ? <QuickButtons item={item} quick={quick} /> : null}
    </div>
  );
}

function QuickButtons({ item, quick }: { item: ReviewItem; quick: QuickDecision }) {
  const t = useTranslations("todo.quick");
  const tErrors = useTranslations("reviews.errors");
  const { formatMoney } = useFormat();
  const mutation = useQuickDecision(item.id);
  const [error, setError] = useState<string | null>(null);
  const money = (m: Money) => formatMoney(m.amount, m.currency);
  const { product } = quick;
  const labels =
    quick.kind === "unavailable"
      ? {
          approve: t("markUnavailable"),
          keep: t("keepAvailable"),
          approved: t("markedUnavailable", { product }),
          kept: t("keptAvailable", { product }),
        }
      : {
          approve:
            quick.kind === "price"
              ? t("update", { price: money(quick.proposed) })
              : t("changeCurrency", { price: money(quick.proposed) }),
          keep: t("keep", { price: money(quick.current) }),
          approved: t("applied", { product, price: money(quick.proposed) }),
          kept: t("kept", { product, price: money(quick.current) }),
        };
  const decide = (action: "approve" | "reject") => {
    setError(null);
    mutation.mutate(action, {
      onSuccess: () => toast.success(action === "approve" ? labels.approved : labels.kept),
      onError: (e) => {
        const { key, params } = resolveErrorKey(e);
        setError(tErrors(key, params));
      },
    });
  };
  const approve = () => decide("approve");
  const keep = () => decide("reject");
  return (
    <div
      role="group"
      aria-label={t("group", { product })}
      className="flex flex-col gap-1.5 sm:shrink-0"
    >
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button className="min-h-11" disabled={mutation.isPending} onClick={approve}>
          {labels.approve}
        </Button>
        <Button variant="outline" className="min-h-11" disabled={mutation.isPending} onClick={keep}>
          {labels.keep}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Link href={`/reviews/${item.id}`} className="font-medium underline underline-offset-4">
            {t("openReview")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A message to check by hand (ADR-032 action alerts): what, when, the chat, and the decision —
 * "Done" for a voice note; "Not an opt-out" or "Opt out" (asked for confirmation: only an admin
 * can opt the contact back in) for an ambiguous opt-out phrase.
 */
function AlertRow({ alert }: { alert: TodoAlert }) {
  const t = useTranslations("todo");
  const tAlerts = useTranslations("alerts");
  const tCommon = useTranslations("common");
  const format = useFormat();
  const ack = useAcknowledgeAlert();
  const optOut = useOptOutFromTodo();
  const [confirming, setConfirming] = useState(false);
  const text = alertText({ ...alert, product: null }, format);
  const title = text ? tAlerts(`titles.${text.key}`, text.params) : alert.title;
  const canOptOut = alert.type === "possible_opt_out" && alert.contactId !== null;
  const Icon = alert.type === "possible_opt_out" ? UserX : Mic;
  const label = alert.type === "possible_opt_out" ? t("notOptOut") : t("done");
  const phrase = typeof alert.details?.matched === "string" ? alert.details.matched : "";
  const busy = (ack.isPending && ack.variables === alert.id) || optOut.isPending;
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
      <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
        {canOptOut ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("optOut")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          className={cn("min-h-11", !canOptOut && "col-span-2")}
          disabled={busy}
          onClick={() => ack.mutate(alert.id)}
          aria-label={t("ackLabel", { action: label, title })}
        >
          {label}
        </Button>
      </div>
      {canOptOut ? (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("optOutTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("optOutBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">{tCommon("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="min-h-11"
                onClick={() =>
                  optOut.mutate(
                    {
                      contactId: alert.contactId!,
                      alertId: alert.id,
                      reason: t("optOutReason", { phrase }),
                    },
                    {
                      onSuccess: () => toast.success(t("optOutDone")),
                      onError: () => toast.error(t("optOutFailed")),
                    },
                  )
                }
              >
                {t("optOutConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
