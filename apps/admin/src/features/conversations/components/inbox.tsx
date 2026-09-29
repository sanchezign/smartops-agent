"use client";

import { Search, UserX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useInbox } from "../hooks";
import { contactName, preview, supplierSuffix, whoAnswers } from "../labels";
import type { InboxFilter, InboxItem } from "../types";
import { WhoBadge } from "./who-badge";

const FILTERS: InboxFilter[] = ["all", "human", "suppliers", "customers", "opted_out"];

export function Inbox() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const query = useInbox(filter, q);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const t = useTranslations("conversations");
  const tCommon = useTranslations("common");
  const tPages = useTranslations("pages");

  return (
    <>
      <PageHeader
        title={tPages("conversations")}
        description={t("description")}
        actions={
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/conversaciones/bajas">
              <UserX aria-hidden /> {t("optedOutLink")}
            </Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={t("search")}
            placeholder={t("search")}
            className="min-h-11 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div role="group" aria-label={t("filter")} className="flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              aria-pressed={filter === f}
              className="min-h-9 shrink-0 rounded-full"
              onClick={() => setFilter(f)}
            >
              {t(`filters.${f}`)}
            </Button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <LoadingState rows={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={q ? t("noMatches") : t("empty")}
          description={q ? t("noMatchesHint") : undefined}
        />
      ) : (
        <>
          <ul
            className="flex flex-col divide-y rounded-xl border bg-card"
            aria-label={t("listLabel")}
          >
            {items.map((item) => (
              <li key={item.id}>
                <InboxRow item={item} />
              </li>
            ))}
          </ul>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              className="mt-3 min-h-11 w-full"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? tCommon("loading") : t("loadMore")}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const who = whoAnswers(item);
  const m = item.lastMessage;
  const unanswered = m?.direction === "inbound";
  const t = useTranslations("conversations");
  const { formatRelative } = useFormat();
  const line = m ? preview(m) : null;
  return (
    <Link
      href={`/conversaciones/${item.id}`}
      className="flex min-h-16 flex-col gap-1 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("truncate", unanswered ? "font-semibold" : "font-medium")}>
          {contactName(item.contact, t("contactFallback"))}
          {supplierSuffix(item.contact) ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {supplierSuffix(item.contact)}
            </span>
          ) : null}
        </span>
        {m ? (
          <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(m.at)}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-muted-foreground">
          {m ? (
            <>
              {m.direction === "outbound"
                ? m.author === "bot"
                  ? t("botPrefix")
                  : t("youPrefix")
                : null}
              {line && "snippet" in line ? line.snippet : line ? t(`types.${line.type}`) : null}
            </>
          ) : null}
        </span>
        {who !== "bot" ? <WhoBadge who={who} className="shrink-0" /> : null}
      </div>
    </Link>
  );
}
