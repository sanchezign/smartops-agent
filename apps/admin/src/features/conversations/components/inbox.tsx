"use client";

import { Search, UserX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, RowLink, RowList } from "@/components/list-row";
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
            <Link href="/conversations/opted-out">
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
          <RowList aria-label={t("listLabel")}>
            {items.map((item) => (
              <li key={item.id}>
                <InboxRow item={item} />
              </li>
            ))}
          </RowList>
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
  const tKinds = useTranslations("contactKinds");
  const { formatRelative } = useFormat();
  const line = m ? preview(m) : null;
  const name = contactName(item.contact, t("contactFallback"));
  const company = supplierSuffix(item.contact);
  return (
    <RowLink href={`/conversations/${item.id}`} emphasis={who === "human"}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-2">
            {unanswered ? (
              <span
                aria-hidden
                className="size-2 shrink-0 -translate-y-0.5 self-center rounded-full bg-foreground"
              />
            ) : null}
            <span className={cn("truncate", unanswered ? "font-semibold" : "font-medium")}>
              {name}
            </span>
            {company ? (
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {company}
              </span>
            ) : null}
          </span>
          {m ? (
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                unanswered ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {formatRelative(m.at)}
            </span>
          ) : null}
        </span>
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <Chip>{tKinds(item.contact.kind)}</Chip>
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
          </span>
          {who !== "bot" ? <WhoBadge who={who} className="shrink-0" /> : null}
        </span>
      </span>
      {unanswered ? <span className="sr-only">{t("unanswered")}</span> : null}
    </RowLink>
  );
}
