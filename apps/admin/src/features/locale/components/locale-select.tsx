"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { LOCALE_NAMES, LOCALES, isAppLocale } from "@/i18n/locales";
import { useChangeLocale } from "../hooks";

/**
 * Visible language selector (phase 13): login screen and anywhere outside the user menu.
 * A native select — keyboard, screen readers and phones handle it without extra code.
 */
export function LocaleSelect({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("locale");
  const change = useChangeLocale();
  const id = useId();

  return (
    <div className={`flex items-center gap-2 text-sm ${className ?? ""}`}>
      <Languages aria-hidden className="size-4 text-muted-foreground" />
      <label htmlFor={id} className="sr-only">
        {t("label")}
      </label>
      <select
        id={id}
        value={locale}
        onChange={(event) => {
          if (isAppLocale(event.target.value)) void change(event.target.value);
        }}
        className="min-h-11 rounded-md border border-input bg-background px-2"
      >
        {LOCALES.map((value) => (
          <option key={value} value={value} lang={value}>
            {LOCALE_NAMES[value]}
          </option>
        ))}
      </select>
    </div>
  );
}
