"use client";

import { AlertTriangle, Clock, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { useConversationAction } from "../hooks";
import type { ConversationHeader } from "../types";

/**
 * Reply as a person (ADR-016): the message goes out through WhatsApp and the bot pauses for
 * this chat. Only inside the 24 h window (outside it WhatsApp only accepts templates). After an
 * opt-out a person may still answer a message the contact sent — with a visible warning.
 */
export function Composer({ conversation }: { conversation: ConversationHeader }) {
  const [text, setText] = useState("");
  const reply = useConversationAction(
    (body: string) => ({
      path: `/admin/conversations/${conversation.id}/reply`,
      body: { text: body },
    }),
    "Enviado. El bot queda en pausa en este chat.",
  );
  const { window } = conversation;

  if (!window.open) {
    return (
      <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
        {window.closesAt
          ? `Pasaron más de 24 h desde su último mensaje (${formatDateTime(window.closesAt)}): WhatsApp no deja escribirle hasta que vuelva a escribir.`
          : "Este contacto nunca escribió: WhatsApp no deja iniciar la conversación sin una plantilla aprobada."}
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
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          Pidió no recibir mensajes. Respondé solo si es necesario para lo que te consultó.
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
          aria-label="Tu respuesta"
          placeholder="Escribí tu respuesta…"
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
          aria-label="Enviar"
          disabled={!text.trim() || reply.isPending}
        >
          <Send aria-hidden />
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Se envía por WhatsApp como la empresa. Al responder, el bot se pausa en este chat.
      </p>
    </div>
  );
}
