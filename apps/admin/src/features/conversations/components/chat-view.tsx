"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { TIME_ZONE } from "@/lib/format";
import { Chip } from "@/components/list-row";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useConversation, useMessages } from "../hooks";
import { contactName, supplierSuffix, whoAnswers } from "../labels";
import type { ChatMessage, ConversationHeader } from "../types";
import { ChatActions } from "./chat-actions";
import { Composer } from "./composer";
import { MessageBubble } from "./message-bubble";
import { WhoBadge } from "./who-badge";

const dayKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(iso));

export function ChatView({ id }: { id: string }) {
  const header = useConversation(id);
  const t = useTranslations("conversations");
  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      {header.isPending ? (
        <>
          <BackButton />
          <LoadingState rows={4} />
        </>
      ) : header.isError ? (
        <>
          <BackButton />
          <ErrorState
            error={header.error}
            onRetry={() => void header.refetch()}
            back={{ href: "/conversations", label: t("backTo") }}
          />
        </>
      ) : (
        <>
          <ChatHeader conversation={header.data.conversation} />
          <MessageList id={id} />
          <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:px-0">
            <Composer conversation={header.data.conversation} />
          </div>
        </>
      )}
    </div>
  );
}

function BackButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const t = useTranslations("conversations");
  return (
    <Button
      asChild
      variant="ghost"
      size={iconOnly ? "icon" : "sm"}
      className={iconOnly ? "size-11 shrink-0" : "mb-2 -ml-2 min-h-9 w-fit"}
    >
      <Link href="/conversations" aria-label={t("back")}>
        <ArrowLeft aria-hidden /> {iconOnly ? null : t("back")}
      </Link>
    </Button>
  );
}

/**
 * The header stays under the top bar while the chat scrolls (phase 14 #8): a chat opens at its
 * newest message, so a header that scrolls away would hide who is answering and the main action
 * exactly when someone needs them. Two compact rows: who (name, kind, phone) and the state with
 * its action. A chat a person is handling gets the ink frame and the yellow tag.
 */
function ChatHeader({ conversation }: { conversation: ConversationHeader }) {
  const c = conversation.contact;
  const who = whoAnswers(conversation);
  const t = useTranslations("conversations");
  const tKinds = useTranslations("contactKinds");
  const { formatTime } = useFormat();
  const until = conversation.humanUntil
    ? t("humanUntil", { time: formatTime(conversation.humanUntil) })
    : t("humanUntilResumed");
  return (
    <header
      className={cn(
        "sticky top-14 z-20 -mx-4 mb-3 border-b-[1.5px] bg-background px-4 py-2 md:top-16 md:mx-0 md:px-0",
        who === "human" ? "border-foreground" : "border-border",
      )}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-1 gap-y-1.5">
        <div className="col-start-1 row-start-1">
          <BackButton iconOnly />
        </div>
        <div className="col-span-2 col-start-2 row-start-1 flex min-w-0 flex-col pr-12">
          <h1 className="font-display line-clamp-2 text-lg leading-tight break-words">
            {contactName(c, t("contactFallback"))}
          </h1>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Chip>{tKinds(c.kind)}</Chip>
            {supplierSuffix(c) ? <span className="truncate">{supplierSuffix(c)}</span> : null}
            {c.waId ? <span className="shrink-0 tabular-nums">+{c.waId}</span> : null}
          </p>
        </div>
        <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2">
          <WhoBadge who={who} detail={who === "human" ? until : undefined} detailOnlyFromTablet />
          {who === "opted_out" && conversation.mode === "human" ? (
            <WhoBadge who="human" detail={until} detailOnlyFromTablet />
          ) : null}
        </div>
        <ChatActions conversation={conversation} />
      </div>
    </header>
  );
}

function MessageList({ id }: { id: string }) {
  const query = useMessages(id);
  const t = useTranslations("conversations");
  const tCommon = useTranslations("common");
  const { formatLongDay } = useFormat();
  const pages = query.data?.pages ?? [];
  // Pages come newest-first (each page oldest-first inside): show oldest page first.
  const messages: ChatMessage[] = [...pages].reverse().flatMap((p) => p.items);
  const newestId = messages.at(-1)?.id;
  const firstLoad = useRef(true);

  // Jump to the newest message on open and when a new one arrives (not when loading older).
  useLayoutEffect(() => {
    if (!newestId) return;
    // To the very end of the page: the sticky composer and the phone's bottom bar sit there,
    // so the newest message ends right above them (scrollIntoView left it underneath).
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: firstLoad.current ? "auto" : "smooth",
    });
    firstLoad.current = false;
  }, [newestId]);
  useEffect(() => {
    firstLoad.current = true;
  }, [id]);

  if (query.isPending) return <LoadingState rows={4} label={t("loadingMessages")} />;
  if (query.isError)
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        back={{ href: "/conversations", label: t("backTo") }}
      />
    );

  let lastDay = "";
  return (
    <section aria-label={t("messagesLabel")} className="flex flex-col gap-2 pb-4">
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          className="min-h-11 self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? tCommon("loading") : t("olderMessages")}
        </Button>
      ) : null}
      {messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noMessages")}</p>
      ) : null}
      {messages.map((m) => {
        const day = dayKey(m.at);
        const separator = day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={m.id}>
            {separator ? (
              <p className="my-2 self-center rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground first-letter:uppercase">
                {formatLongDay(m.at)}
              </p>
            ) : null}
            <MessageBubble message={m} />
          </Fragment>
        );
      })}
    </section>
  );
}
