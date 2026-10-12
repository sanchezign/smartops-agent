"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { RowLink, RowList } from "@/components/list-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/lib/use-format";
import { useReviews } from "../hooks";
import { reviewTitle } from "../labels";
import { sourceKind } from "../source";
import { SourceIcon } from "../source-icon";
import type { ReviewItem } from "../types";

const STATUSES = ["approved", "rejected"] as const;

/**
 * Decisions already taken (phase 15, ADR-032): what the old Reviews status filter showed, one
 * click away from To do. Read-only rows; each opens the review with its resolution.
 */
export function ResolvedList() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("approved");
  const query = useReviews({ status, scope: "all" });
  const t = useTranslations("reviews");
  const tTodo = useTranslations("todo");
  const tPages = useTranslations("pages");

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href="/todo">
          <ArrowLeft aria-hidden /> {tPages("todo")}
        </Link>
      </Button>
      <PageHeader title={tPages("resolved")} description={tTodo("resolvedDescription")} />
      <div
        role="group"
        aria-label={t("statusFilter")}
        className="mb-4 inline-flex w-fit rounded-lg border-[1.5px] p-1"
      >
        {STATUSES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "secondary" : "ghost"}
            aria-pressed={status === s}
            className="min-h-9"
            onClick={() => setStatus(s)}
          >
            {t(`statusFilters.${s}`)}
          </Button>
        ))}
      </div>

      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={t("emptyOther")} />
      ) : (
        <RowList aria-label={tPages("resolved")}>
          {query.data.items.map((item) => (
            <li key={item.id}>
              <ResolvedRow item={item} />
            </li>
          ))}
        </RowList>
      )}
    </>
  );
}

function ResolvedRow({ item }: { item: ReviewItem }) {
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
    <RowLink href={`/reviews/${item.id}`}>
      <SourceIcon kind={sourceKind(item.message)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{title}</span>
          <Badge variant="outline">{t(`kinds.${item.kind}`)}</Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
          <span className="truncate">{item.supplier?.name ?? t("unknownSupplier")}</span>
          <span className="tabular-nums">
            {formatRelative(item.resolvedAt ?? item.message.receivedAt)}
          </span>
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </RowLink>
  );
}
