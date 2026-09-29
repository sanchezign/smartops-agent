"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/store";
import { useDemoInfo } from "@/features/demo/hooks";
import { isPublicDemoAccount } from "@/features/demo/public-account";
import { localeCookie, type AppLocale } from "@/i18n/locales";

/** Stores the choice in the cookie the server reads (src/i18n/request.ts). */
export function storeLocaleCookie(locale: AppLocale) {
  document.cookie = localeCookie(locale, window.location.protocol === "https:");
}

/**
 * Switches the panel language (phase 13): cookie for this browser + the person's profile (so it
 * follows them to other devices), then a reload so every screen re-renders in that language.
 * The shared public demo operator keeps it in the cookie only (one visitor must not change
 * another's language; the API refuses it too).
 */
export function useChangeLocale() {
  const current = useLocale();
  const t = useTranslations("locale");
  const user = useAuthStore((s) => s.user);
  const demo = useDemoInfo().data;

  return useCallback(
    async (next: AppLocale) => {
      if (next === current) return;
      storeLocaleCookie(next);
      if (user && !isPublicDemoAccount(demo, user.email)) {
        try {
          await api.setLocale(next);
        } catch {
          toast.error(t("saveFailed"));
          // Let the message be read before the page reloads.
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
      window.location.reload();
    },
    [current, user, demo, t],
  );
}
