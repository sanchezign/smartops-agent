"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { useOptedOut } from "../hooks";
import { KIND_LABEL, contactName } from "../labels";
import type { OptedOutContact } from "../types";

function howText(c: OptedOutContact): string {
  const last = c.lastOptOut;
  if (!last) return "Baja registrada";
  if (last.method === "keyword") return `Escribió "${(last.keyword ?? "").toUpperCase()}"`;
  const who = last.by ? ` por ${last.by}` : "";
  return last.method === "off_whatsapp"
    ? `Lo pidió fuera de WhatsApp (registrado${who})`
    : `Registrada a mano${who}`;
}

/** Contacts that asked not to receive messages (ADR-017: the panel must show them). */
export function OptedOutList() {
  const query = useOptedOut();
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 min-h-9">
        <Link href="/conversaciones">
          <ArrowLeft aria-hidden /> Conversaciones
        </Link>
      </Button>
      <PageHeader
        title="Dados de baja"
        description="Pidieron no recibir mensajes: el sistema no les envía nada automático. Si escriben, una persona puede responderles."
      />
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.contacts.length === 0 ? (
        <EmptyState title="Nadie pidió la baja" />
      ) : (
        <ul
          className="flex flex-col divide-y rounded-xl border bg-card"
          aria-label="Contactos dados de baja"
        >
          {query.data.contacts.map((c) => {
            const body = (
              <>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{contactName(c)}</span>
                  <span className="text-sm text-muted-foreground">
                    {KIND_LABEL[c.kind]} · {howText(c)}
                    {c.optOutAt ? ` · ${formatDateTime(c.optOutAt)}` : ""}
                  </span>
                </div>
                {c.conversationId ? (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
              </>
            );
            return (
              <li key={c.id}>
                {c.conversationId ? (
                  <Link
                    href={`/conversaciones/${c.conversationId}`}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/50"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex min-h-16 items-center gap-3 px-4 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
