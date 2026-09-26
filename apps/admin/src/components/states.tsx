"use client";

import { AlertTriangle, Inbox, Lock, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";

/**
 * The same four states on every screen (phase 9): loading, empty, error, forbidden.
 * Screen readers are told what is happening (role=status / role=alert).
 */

export function LoadingState({ rows = 3, label = "Cargando…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = <Inbox className="size-8" aria-hidden />,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ForbiddenState() {
  return (
    <EmptyState
      icon={<Lock className="size-8" aria-hidden />}
      title="No tenés permiso para ver esto"
      description="Esta sección es solo para administradores. Si la necesitás, pedíselo a quien administra el panel."
    />
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <ForbiddenState />;
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
    >
      <AlertTriangle className="size-8 text-destructive" aria-hidden />
      <p className="font-medium">No pudimos cargar esta información</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Puede ser un problema momentáneo. Probá de nuevo; si sigue pasando, avisá al equipo
        {requestId ? (
          <>
            {" "}
            con este código: <code className="font-mono">{requestId}</code>
          </>
        ) : null}
        .
      </p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden /> Reintentar
        </Button>
      ) : null}
    </div>
  );
}
