"use client";

import { AlertOctagon, AlertTriangle, Check, Info } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { alertText } from "../alert-text";
import { useAcknowledgeAlert, useAlerts } from "../hooks";

const STATUS_FILTERS = ["open", "all"] as const;

const SEVERITY = {
  critical: { icon: AlertOctagon, className: "text-destructive" },
  warning: { icon: AlertTriangle, className: "text-amber-600" },
  info: { icon: Info, className: "text-muted-foreground" },
} as const;

export function AlertsView() {
  const [status, setStatus] = useState<"open" | "all">("open");
  const query = useAlerts(status);
  const ack = useAcknowledgeAlert();
  const t = useTranslations("alerts");
  const tPages = useTranslations("pages");
  const format = useFormat();
  const { formatRelative } = format;
  return (
    <>
      <PageHeader title={tPages("alerts")} description={t("description")} />
      <div role="group" aria-label={t("status")} className="mb-4 inline-flex rounded-lg border p-1">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "secondary" : "ghost"}
            aria-pressed={status === s}
            className="min-h-9"
            onClick={() => setStatus(s)}
          >
            {s === "open"
              ? query.data
                ? t("unseenCount", { count: query.data.open })
                : t("unseen")
              : t("all")}
          </Button>
        ))}
      </div>
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={status === "open" ? t("emptyUnseen") : t("empty")} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
          {query.data.items.map((a) => {
            const sev = SEVERITY[a.severity];
            const Icon = sev.icon;
            const open = a.status === "open" || a.status === "sent";
            const text = alertText(a, format);
            const title = text ? t(`titles.${text.key}`, text.params) : a.title;
            return (
              <li
                key={a.id}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card p-4",
                  !open && "opacity-75",
                )}
              >
                <Icon
                  className={cn("mt-0.5 size-5 shrink-0", sev.className)}
                  aria-label={t(`severity.${a.severity}`)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="font-medium break-words">{title}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <Badge variant="outline">{t(`types.${a.type}`)}</Badge>
                    {formatRelative(a.createdAt)}
                    {a.product ? (
                      <Link
                        href={`/catalogo/${a.product.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {t("viewProduct")}
                      </Link>
                    ) : null}
                    {a.conversationId ? (
                      <Link
                        href={`/conversaciones/${a.conversationId}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {t("viewConversation")}
                      </Link>
                    ) : null}
                  </p>
                </div>
                {open ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0"
                    disabled={ack.isPending && ack.variables === a.id}
                    onClick={() => ack.mutate(a.id)}
                    aria-label={t("markSeen", { title })}
                  >
                    <Check aria-hidden /> {t("seen")}
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{t("seen")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
