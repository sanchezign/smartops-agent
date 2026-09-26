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
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/features/auth/store";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useReviews, useReviewSummary, type ReviewFilter } from "../hooks";
import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, reviewTitle } from "../labels";
import { canResolve } from "../permissions";
import type { ReviewItem, ReviewScope, ReviewStatus } from "../types";

const SCOPES: (ReviewScope | "all")[] = ["all", "run", "line", "catalog"];
const STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];

export function ReviewList() {
  const [filter, setFilter] = useState<ReviewFilter>({ status: "pending", scope: "all" });
  const summary = useReviewSummary();
  const query = useReviews(filter);
  const user = useAuthStore((s) => s.user);

  const count = (scope: ReviewScope | "all") =>
    summary.data ? (scope === "all" ? summary.data.total : summary.data.byScope[scope]) : null;

  return (
    <>
      <PageHeader
        title="Revisiones"
        description="Lo que el sistema no decide solo. Nada de esto se aplicó todavía al catálogo."
      />
      <div className="mb-4 flex flex-col gap-3">
        <div role="group" aria-label="Tipo de revisión" className="flex gap-2 overflow-x-auto pb-1">
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
                {scope === "all" ? "Todas" : SCOPE_LABEL[scope]}
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
        <div role="group" aria-label="Estado" className="inline-flex w-fit rounded-lg border p-1">
          {STATUSES.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={filter.status === status ? "secondary" : "ghost"}
              aria-pressed={filter.status === status}
              className="min-h-9"
              onClick={() => setFilter((f) => ({ ...f, status }))}
            >
              {status === "pending" ? "Pendientes" : `${STATUS_LABEL[status]}s`}
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
          title={filter.status === "pending" ? "No hay nada para revisar" : "No hay revisiones acá"}
          description={
            filter.status === "pending"
              ? "Todo lo que llegó se procesó solo. Cuando algo necesite tu decisión, aparece acá."
              : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Revisiones">
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
  return (
    <Link
      href={`/revisiones/${item.id}`}
      className="flex min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <SourceIcon item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{reviewTitle(item)}</span>
          <Badge variant={item.scope === "line" ? "secondary" : "outline"}>
            {KIND_LABEL[item.kind]}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {item.supplier?.name ?? "Proveedor sin identificar"} ·{" "}
          {formatRelative(item.message.receivedAt)}
          {readOnly && item.status === "pending" ? " · la resuelve un administrador" : ""}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
