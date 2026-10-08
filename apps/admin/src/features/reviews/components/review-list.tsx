"use client";

import {
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Lock,
  Image as ImageIcon,
  Mic,
  MessageSquare,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { RowLink, RowList } from "@/components/list-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useReviews, useReviewSummary, type ReviewFilter } from "../hooks";
import { reviewTitle } from "../labels";
import { useDemoInfo } from "@/features/demo/hooks";
import { canResolve } from "../permissions";
import type { ReviewItem, ReviewScope, ReviewStatus } from "../types";

const SCOPES: (ReviewScope | "all")[] = ["all", "run", "line", "catalog"];
const STATUSES = ["pending", "approved", "rejected"] as const satisfies readonly ReviewStatus[];

export function ReviewList() {
  const [filter, setFilter] = useState<ReviewFilter>({ status: "pending", scope: "all" });
  const summary = useReviewSummary();
  const query = useReviews(filter);
  const user = useAuthStore((s) => s.user);
  const demoMode = useDemoInfo().data != null; // ADR-030
  const t = useTranslations("reviews");
  const tPages = useTranslations("pages");

  const count = (scope: ReviewScope | "all") =>
    summary.data ? (scope === "all" ? summary.data.total : summary.data.byScope[scope]) : null;

  return (
    <>
      <PageHeader title={tPages("reviews")} description={t("description")} />
      <div className="mb-4 flex flex-col gap-3">
        <div role="group" aria-label={t("typeFilter")} className="flex gap-2 overflow-x-auto pb-1">
          {SCOPES.map((scope) => {
            const n = filter.status === "pending" ? count(scope) : null;
            const active = filter.scope === scope;
            return (
              <Button
                key={scope}
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                className="min-h-9 shrink-0 rounded-full"
                onClick={() => setFilter((f) => ({ ...f, scope }))}
              >
                {scope === "all" ? t("all") : t(`scopes.${scope}`)}
                {n !== null ? (
                  <span
                    className={cn(
                      "ml-1 rounded-full border-[1.5px] px-1.5 text-xs font-bold tabular-nums",
                      n > 0
                        ? "border-signal-foreground bg-signal text-signal-foreground dark:border-signal"
                        : "border-transparent bg-muted text-muted-foreground",
                    )}
                  >
                    {n}
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
        <div
          role="group"
          aria-label={t("statusFilter")}
          className="inline-flex w-fit rounded-lg border-[1.5px] p-1"
        >
          {STATUSES.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={filter.status === status ? "secondary" : "ghost"}
              aria-pressed={filter.status === status}
              className="min-h-9"
              onClick={() => setFilter((f) => ({ ...f, status }))}
            >
              {t(`statusFilters.${status}`)}
            </Button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filter.status === "pending" ? t("emptyPending") : t("emptyOther")}
          description={filter.status === "pending" ? t("emptyPendingHint") : undefined}
        />
      ) : (
        <RowList aria-label={t("listLabel")}>
          {query.data.items.map((item) => (
            <li key={item.id}>
              <ReviewRow item={item} readOnly={!canResolve(user, item, { demoMode })} />
            </li>
          ))}
        </RowList>
      )}
    </>
  );
}

function SourceIcon({ item }: { item: ReviewItem }) {
  const mime = item.message.media?.mimeType ?? "";
  const className = "size-4 shrink-0 text-muted-foreground";
  if (item.message.type === "audio") return <Mic className={className} aria-hidden />;
  if (item.message.type === "image") return <ImageIcon className={className} aria-hidden />;
  if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv"))
    return <FileSpreadsheet className={className} aria-hidden />;
  if (item.message.type === "document") return <FileText className={className} aria-hidden />;
  return <MessageSquare className={className} aria-hidden />;
}

function ReviewRow({ item, readOnly }: { item: ReviewItem; readOnly: boolean }) {
  const t = useTranslations("reviews");
  const { formatPct, formatRelative } = useFormat();
  const title = reviewTitle(item, {
    line: t("titles.line"),
    product: t("titles.product"),
    message: t("titles.message"),
    globalChange: (pct, count) =>
      t("titles.globalChange", { pct: pct ? formatPct(pct) : t("titles.change"), count }),
  });
  return (
    <RowLink href={`/reviews/${item.id}`} emphasis={item.status === "pending"}>
      <SourceIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{title}</span>
          <Badge variant={item.scope === "line" ? "secondary" : "outline"}>
            {t(`kinds.${item.kind}`)}
          </Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
          <span className="truncate">{item.supplier?.name ?? t("unknownSupplier")}</span>
          <span className="tabular-nums">{formatRelative(item.message.receivedAt)}</span>
          {readOnly && item.status === "pending" ? (
            <span className="flex items-center gap-1">
              <Lock className="size-3.5" aria-hidden />
              {t("adminResolves")}
            </span>
          ) : null}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </RowLink>
  );
}
