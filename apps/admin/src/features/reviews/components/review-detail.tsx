"use client";

import { ArrowLeft, FileText, Lock, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuthStore } from "@/features/auth/store";
import { useFormat } from "@/lib/use-format";
import { useResolveReview, useReview, type ResolveInput } from "../hooks";
import { isKnownReason, rawReason } from "../labels";
import { canResolve } from "../permissions";
import type { ReviewItem } from "../types";
import { ColumnMappingResolver } from "./column-mapping-resolver";
import { LineResolver } from "./line-resolver";
import {
  GateResolver,
  GlobalChangeResolver,
  MarkUnavailableResolver,
  SupplierResolver,
} from "./other-resolvers";

export function ReviewDetail({ id }: { id: string }) {
  const router = useRouter();
  const query = useReview(id);
  const user = useAuthStore((s) => s.user);
  const mutation = useResolveReview(id, () => router.push("/reviews"));
  const t = useTranslations("reviews");

  return (
    <div className="mx-auto max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href="/reviews">
          <ArrowLeft aria-hidden /> {t("back")}
        </Link>
      </Button>
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          back={{ href: "/reviews", label: t("backTo") }}
        />
      ) : (
        <DetailBody
          item={query.data.item}
          readOnly={!canResolve(user, query.data.item) || query.data.item.status !== "pending"}
          pending={mutation.isPending}
          onResolve={(input) => mutation.mutate(input)}
        />
      )}
    </div>
  );
}

function DetailBody({
  item,
  readOnly,
  pending,
  onResolve,
}: {
  item: ReviewItem;
  readOnly: boolean;
  pending: boolean;
  onResolve(input: ResolveInput): void;
}) {
  const props = { item, readOnly, pending, onResolve };
  const t = useTranslations("reviews");
  const { formatDateTime } = useFormat();
  return (
    <>
      <header className="mb-5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t(`kinds.${item.kind}`)}</h1>
          {item.status !== "pending" ? (
            <Badge variant="outline">{t(`statuses.${item.status}`)}</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t(`help.${item.kind}`)}</p>
        {item.reasons.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.reasons.map((r) => (
              <Badge key={r} variant="secondary">
                {isKnownReason(r) ? t(`reasons.${r}`) : rawReason(r)}
              </Badge>
            ))}
          </div>
        ) : null}
      </header>

      <SourceCard item={item} />

      {item.status !== "pending" && item.resolvedAt ? (
        <p className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm">
          {t("resolvedOn", {
            status: t(`statuses.${item.status}`),
            when: formatDateTime(item.resolvedAt),
          })}
        </p>
      ) : null}

      {item.scope === "line" ? (
        <LineResolver {...props} />
      ) : item.kind === "column_mapping" ? (
        <ColumnMappingResolver {...props} />
      ) : item.kind === "global_change" ? (
        <GlobalChangeResolver {...props} />
      ) : item.kind === "mark_unavailable" ? (
        <MarkUnavailableResolver {...props} />
      ) : item.kind === "unknown_supplier" ? (
        <SupplierResolver {...props} />
      ) : (
        <GateResolver {...props} />
      )}
      {item.status === "pending" && readOnly ? (
        // Exactly where the approve / reject buttons would be (pinned at the bottom on phones):
        // an operator must not wonder where the buttons went (user, phase 9 phone tests).
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
          <p
            role="note"
            className="flex items-start gap-2 rounded-lg border bg-muted/60 p-3 text-sm"
          >
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <strong>{t("adminOnlyTitle")}</strong> {t("adminOnlyBody")}
            </span>
          </p>
        </div>
      ) : null}
    </>
  );
}

/** Where it came from: supplier, when, and the original message (text or transcript). */
function SourceCard({ item }: { item: ReviewItem }) {
  const t = useTranslations("reviews");
  const { formatDateTime } = useFormat();
  const text = item.message.transcript ?? item.message.text;
  return (
    <Card className="mb-5">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium">{item.supplier?.name ?? t("unknownSupplier")}</span>
          <span className="text-muted-foreground">{formatDateTime(item.message.receivedAt)}</span>
        </div>
        {item.message.media?.filename ? (
          <p className="flex items-center gap-2 text-sm">
            <FileText className="size-4 text-muted-foreground" aria-hidden />
            {item.message.media.filename}
          </p>
        ) : null}
        {text ? (
          <blockquote className="line-clamp-6 border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {item.message.transcript ? (
              <span className="sr-only">{t("transcriptPrefix")}</span>
            ) : null}
            {text}
          </blockquote>
        ) : null}
        <Link
          href={`/conversations/${item.message.conversationId}`}
          prefetch={false}
          className="flex min-h-9 w-fit items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
        >
          <MessagesSquare className="size-4" aria-hidden /> {t("viewConversation")}
        </Link>
      </CardContent>
    </Card>
  );
}
