"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { TIME_ZONE } from "@/lib/format";
import { useConversation, useMessages } from "../hooks";
import { KIND_LABEL, contactName, humanUntilText, supplierSuffix, whoAnswers } from "../labels";
import type { ChatMessage, ConversationHeader } from "../types";
import { ChatActions } from "./chat-actions";
import { Composer } from "./composer";
import { MessageBubble } from "./message-bubble";
import { WhoBadge } from "./who-badge";

const dayFormat = new Intl.DateTimeFormat("es-UY", {
  timeZone: TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});
const dayKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(iso));

export function ChatView({ id }: { id: string }) {
  const header = useConversation(id);
  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 w-fit min-h-9">
        <Link href="/conversaciones">
          <ArrowLeft aria-hidden /> Conversaciones
        </Link>
      </Button>
      {header.isPending ? (
        <LoadingState rows={4} />
      ) : header.isError ? (
        <ErrorState error={header.error} onRetry={() => void header.refetch()} />
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

function ChatHeader({ conversation }: { conversation: ConversationHeader }) {
  const c = conversation.contact;
  const who = whoAnswers(conversation);
  return (
    <header className="mb-4 flex flex-col gap-3 border-b pb-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{contactName(c)}</h1>
        <p className="text-sm text-muted-foreground">
          {KIND_LABEL[c.kind]}
          {supplierSuffix(c) ? ` · ${supplierSuffix(c)}` : ""}
          {c.waId ? ` · +${c.waId}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WhoBadge
          who={who}
          detail={who === "human" ? humanUntilText(conversation.humanUntil) : undefined}
        />
        {who === "opted_out" && conversation.mode === "human" ? (
          <WhoBadge who="human" detail={humanUntilText(conversation.humanUntil)} />
        ) : null}
      </div>
      <ChatActions conversation={conversation} />
    </header>
  );
}

function MessageList({ id }: { id: string }) {
  const query = useMessages(id);
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

  if (query.isPending) return <LoadingState rows={4} label="Cargando mensajes…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  let lastDay = "";
  return (
    <section aria-label="Mensajes" className="flex flex-col gap-2 pb-4">
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          className="min-h-11 self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Cargando…" : "Ver mensajes anteriores"}
        </Button>
      ) : null}
      {messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Todavía no hay mensajes.</p>
      ) : null}
      {messages.map((m) => {
        const day = dayKey(m.at);
        const separator = day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={m.id}>
            {separator ? (
              <p className="my-2 self-center rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground first-letter:uppercase">
                {dayFormat.format(new Date(m.at))}
              </p>
            ) : null}
            <MessageBubble message={m} />
          </Fragment>
        );
      })}
    </section>
  );
}
