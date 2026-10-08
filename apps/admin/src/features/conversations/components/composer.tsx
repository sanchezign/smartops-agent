"use client";

import { AlertTriangle, Clock, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/lib/use-format";
import { useConversationAction } from "../hooks";
import type { ConversationHeader } from "../types";

/**
 * Reply as a person (ADR-016): the message goes out through WhatsApp and the bot pauses for
 * this chat. Only inside the 24 h window (outside it WhatsApp only accepts templates). After an
 * opt-out a person may still answer a message the contact sent — with a visible warning.
 */
export function Composer({ conversation }: { conversation: ConversationHeader }) {
  const [text, setText] = useState("");
  const t = useTranslations("conversations.composer");
  const { formatDateTime } = useFormat();
  const reply = useConversationAction(
    (body: string) => ({
      path: `/admin/conversations/${conversation.id}/reply`,
      body: { text: body },
    }),
    t("sent"),
  );
  const { window } = conversation;

  if (!window.open) {
    return (
      <p className="flex items-start gap-2 rounded-lg border-[1.5px] bg-muted/40 p-3 text-sm">
        <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
        {window.closesAt
          ? t("windowClosed", { when: formatDateTime(window.closesAt) })
          : t("neverWrote")}
      </p>
    );
  }

  const send = () => {
    const body = text.trim();
    if (!body) return;
    reply.mutate(body, { onSuccess: () => setText("") });
  };

  return (
    <div className="flex flex-col gap-2">
      {conversation.contact.optOutAt ? (
        <p className="flex items-start gap-2 rounded-lg border-[1.5px] border-destructive/40 bg-destructive/5 p-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {t("optedOutWarning")}
        </p>
      ) : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          aria-label={t("label")}
          placeholder={t("placeholder")}
          value={text}
          maxLength={4096}
          rows={1}
          className="max-h-40 min-h-11 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter = new line (phones); Ctrl/Cmd + Enter sends from a keyboard.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="size-11 shrink-0"
          aria-label={t("send")}
          disabled={!text.trim() || reply.isPending}
        >
          <Send aria-hidden />
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
