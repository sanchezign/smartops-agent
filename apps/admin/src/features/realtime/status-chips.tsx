"use client";

import { BotOff, Moon } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api";
import { TIME_ZONE } from "@/lib/format";

interface Status {
  autoRepliesEnabled: boolean;
  businessHours: { configured: boolean; open: boolean; nextOpening: string | null };
}

const opening = new Intl.DateTimeFormat("es-UY", {
  timeZone: TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Fuera de horario" and "Bot apagado" in the top bar (phase 9 M6). */
export function StatusChips() {
  const query = useApiQuery<Status>(["status"], "/admin/status", {
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  if (!query.data) return null;
  const { autoRepliesEnabled, businessHours } = query.data;
  return (
    <span className="flex items-center gap-2 text-xs">
      {businessHours.configured && !businessHours.open ? (
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-muted-foreground">
          <Moon className="size-3" aria-hidden />
          Fuera de horario
          {businessHours.nextOpening ? (
            <span className="hidden sm:inline">
              {" "}
              · abre {opening.format(new Date(businessHours.nextOpening))}
            </span>
          ) : null}
        </span>
      ) : null}
      {!autoRepliesEnabled ? (
        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <BotOff className="size-3" aria-hidden />
          Bot apagado
        </span>
      ) : null}
    </span>
  );
}
