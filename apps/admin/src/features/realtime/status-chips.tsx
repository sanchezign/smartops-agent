"use client";

import { BotOff, Moon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";

interface Status {
  autoRepliesEnabled: boolean;
  businessHours: { configured: boolean; open: boolean; nextOpening: string | null };
}

/** "Outside business hours" and "Bot off" in the top bar (phase 9 M6). */
export function StatusChips() {
  const t = useTranslations("realtime");
  const format = useFormat();
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
          {t("closed")}
          {businessHours.nextOpening ? (
            <span className="hidden sm:inline">
              {" "}
              · {t("opens", { when: format.formatWeekdayTime(businessHours.nextOpening) })}
            </span>
          ) : null}
        </span>
      ) : null}
      {!autoRepliesEnabled ? (
        <span className="flex items-center gap-1 rounded-full border border-warning px-2 py-1 text-warning">
          <BotOff className="size-3" aria-hidden />
          {t("botOff")}
        </span>
      ) : null}
    </span>
  );
}
