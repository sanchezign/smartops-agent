"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useRealtimeStore } from "./store";

/** Small status of the real-time connection in the top bar (announced politely). */
export function LiveIndicator() {
  const status = useRealtimeStore((s) => s.status);
  const t = useTranslations("realtime");
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={status === "live" ? t("liveHint") : t("fallbackHint")}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          status === "live" ? "bg-emerald-600" : "animate-pulse bg-amber-500",
        )}
      />
      {t(status)}
    </span>
  );
}
