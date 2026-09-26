"use client";

import { AlertOctagon, AlertTriangle, Check, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAcknowledgeAlert, useAlerts } from "../hooks";
import type { AlertItem } from "../types";

const TYPE_LABEL: Record<AlertItem["type"], string> = {
  price_change: "Cambio de precio",
  low_stock: "Poco stock",
  missing_data: "Faltan datos",
  ingestion_error: "Error al procesar",
  manual_attention: "Revisar a mano",
  integration_error: "Integración",
  possible_opt_out: "¿Pidió la baja?",
};

const SEVERITY = {
  critical: { icon: AlertOctagon, className: "text-destructive", label: "Crítica" },
  warning: { icon: AlertTriangle, className: "text-amber-600", label: "Importante" },
  info: { icon: Info, className: "text-muted-foreground", label: "Informativa" },
} as const;

export function AlertsView() {
  const [status, setStatus] = useState<"open" | "all">("open");
  const query = useAlerts(status);
  const ack = useAcknowledgeAlert();
  return (
    <>
      <PageHeader
        title="Alertas"
        description="Lo que conviene mirar: aumentos grandes, poco stock, errores. Marcalas como vistas cuando las resuelvas."
      />
      <div role="group" aria-label="Estado" className="mb-4 inline-flex rounded-lg border p-1">
        {(["open", "all"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "secondary" : "ghost"}
            aria-pressed={status === s}
            className="min-h-9"
            onClick={() => setStatus(s)}
          >
            {s === "open" ? `Sin ver${query.data ? ` (${query.data.open})` : ""}` : "Todas"}
          </Button>
        ))}
      </div>
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={status === "open" ? "No hay alertas sin ver" : "No hay alertas"} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Alertas">
          {query.data.items.map((a) => {
            const sev = SEVERITY[a.severity];
            const Icon = sev.icon;
            const open = a.status === "open" || a.status === "sent";
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
                  aria-label={sev.label}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="font-medium break-words">{a.title}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <Badge variant="outline">{TYPE_LABEL[a.type]}</Badge>
                    {formatRelative(a.createdAt)}
                    {a.product ? (
                      <Link
                        href={`/catalogo/${a.product.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        Ver producto
                      </Link>
                    ) : null}
                    {a.conversationId ? (
                      <Link
                        href={`/conversaciones/${a.conversationId}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        Ver conversación
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
                    aria-label={`Marcar como vista: ${a.title}`}
                  >
                    <Check aria-hidden /> Vista
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">Vista</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
