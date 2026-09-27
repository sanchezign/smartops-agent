"use client";

import { cn } from "@/lib/utils";
import { useRealtimeStore } from "./store";

const TEXT = {
  live: "En vivo",
  connecting: "Conectando…",
  offline: "Reconectando…",
  degraded: "Actualización cada 30 s",
} as const;

/** Small status of the real-time connection in the top bar (announced politely). */
export function LiveIndicator() {
  const status = useRealtimeStore((s) => s.status);
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={
        status === "live" ? "Los cambios aparecen solos" : "Actualizando cada 30 s mientras tanto"
      }
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          status === "live" ? "bg-emerald-600" : "animate-pulse bg-amber-500",
        )}
      />
      {TEXT[status]}
    </span>
  );
}
