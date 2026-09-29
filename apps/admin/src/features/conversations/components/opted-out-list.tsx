"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/lib/use-format";
import { useOptedOut } from "../hooks";
import { contactName } from "../labels";
import type { OptedOutContact } from "../types";

/** How the opt-out happened: a "conversations.optedOut" key + params. */
export function howKey(c: OptedOutContact): {
  key: "recorded" | "keyword" | "offWhatsapp" | "offWhatsappBy" | "manual" | "manualBy";
  params?: Record<string, string>;
} {
  const last = c.lastOptOut;
  if (!last) return { key: "recorded" };
  if (last.method === "keyword")
    return { key: "keyword", params: { keyword: (last.keyword ?? "").toUpperCase() } };
  if (last.method === "off_whatsapp")
    return last.by ? { key: "offWhatsappBy", params: { by: last.by } } : { key: "offWhatsapp" };
  return last.by ? { key: "manualBy", params: { by: last.by } } : { key: "manual" };
}

/** Contacts that asked not to receive messages (ADR-017: the panel must show them). */
export function OptedOutList() {
  const query = useOptedOut();
  const t = useTranslations("conversations");
  const tKinds = useTranslations("contactKinds");
  const tPages = useTranslations("pages");
  const { formatDateTime } = useFormat();
  const howText = (c: OptedOutContact) => {
    const { key, params } = howKey(c);
    return t(`optedOut.${key}`, params);
  };
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 min-h-9">
        <Link href="/conversaciones">
          <ArrowLeft aria-hidden /> {t("back")}
        </Link>
      </Button>
      <PageHeader title={tPages("optedOut")} description={t("optedOut.description")} />
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.contacts.length === 0 ? (
        <EmptyState title={t("optedOut.empty")} />
      ) : (
        <ul
          className="flex flex-col divide-y rounded-xl border bg-card"
          aria-label={t("optedOut.listLabel")}
        >
          {query.data.contacts.map((c) => {
            const body = (
              <>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">
                    {contactName(c, t("contactFallback"))}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {tKinds(c.kind)} · {howText(c)}
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
