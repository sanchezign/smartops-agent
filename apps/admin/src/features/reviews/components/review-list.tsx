"use client";

import {
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Mic,
  MessageSquare,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useReviews, useReviewSummary, type ReviewFilter } from "../hooks";
import { reviewTitle } from "../labels";
import { canResolve } from "../permissions";
import type { ReviewItem, ReviewScope, ReviewStatus } from "../types";

const SCOPES: (ReviewScope | "all")[] = ["all", "run", "line", "catalog"];
const STATUSES = ["pending", "approved", "rejected"] as const satisfies readonly ReviewStatus[];

export function ReviewList() {
  const [filter, setFilter] = useState<ReviewFilter>({ status: "pending", scope: "all" });
  const summary = useReviewSummary();
  const query = useReviews(filter);
  const user = useAuthStore((s) => s.user);
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
                      "ml-1 rounded-full px-1.5 text-xs tabular-nums",
                      active ? "bg-primary-foreground/20" : "bg-muted",
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
          className="inline-flex w-fit rounded-lg border p-1"
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
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
          {query.data.items.map((item) => (
            <li key={item.id}>
              <ReviewRow item={item} readOnly={!canResolve(user, item)} />
            </li>
          ))}
        </ul>
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
    <Link
      href={`/reviews/${item.id}`}
      className="flex min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <SourceIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{title}</span>
          <Badge variant={item.scope === "line" ? "secondary" : "outline"}>
            {t(`kinds.${item.kind}`)}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {item.supplier?.name ?? t("unknownSupplier")} · {formatRelative(item.message.receivedAt)}
          {readOnly && item.status === "pending" ? ` · ${t("adminResolves")}` : ""}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
