/**
 * Formatting for the panel (phase 9; per language since phase 13). Numbers and dates follow the
 * PANEL language: en → en-US ("$1,850.00", "Sep 28"), es → es-UY ("$ 1.850,00", "28 set.").
 * Time zone is always the business's (America/Montevideo). Money and percentages come from the
 * API as Decimal STRINGS — they are only formatted here, never used for arithmetic.
 *
 * Currency (ADR-035): US dollars are "$1,850.00" (en) / "US$ 1.850,00" (es); any other currency
 * shows its ISO code in both languages ("CAD 79.90", "UYU 2.390,00") — two currencies never share "$".
 *
 * Components use `useFormat()` (lib/use-format.ts); pure code receives a `Formatter`.
 */

import type { AppLocale } from "@/i18n/locales";

export const TIME_ZONE = "America/Montevideo";

const INTL_LOCALE: Record<AppLocale, string> = { en: "en-US", es: "es-UY" };

/** Relative times ("5 min ago"). Spanish wording is neutral (phase 13). */
const RELATIVE: Record<
  AppLocale,
  {
    now: string;
    minutes: (n: string) => string;
    hours: (n: string) => string;
    yesterday: string;
    days: (n: string) => string;
  }
> = {
  en: {
    now: "just now",
    minutes: (n) => `${n} min ago`,
    hours: (n) => `${n} h ago`,
    yesterday: "yesterday",
    days: (n) => `${n} days ago`,
  },
  es: {
    now: "hace un momento",
    minutes: (n) => `hace ${n} min`,
    hours: (n) => `hace ${n} h`,
    yesterday: "ayer",
    days: (n) => `hace ${n} días`,
  },
};

export interface NumberOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  grouping?: boolean;
}

export interface Formatter {
  locale: AppLocale;
  formatInt(value: number): string;
  /** 0.826 → "83%" (en) / "83 %" (es); null → "—". */
  formatRatio(value: number | null): string;
  /** Money from a Decimal string ("1234.5"), without going through a binary float. */
  formatMoney(value: string, currency: string, maximumFractionDigits?: number): string;
  /** USD for texts: cents ("US$0.16"); only an amount under one cent keeps 4 decimals. */
  formatUsd(value: string): string;
  /** USD with up to 4 decimals: chart tooltips and tables, where each day's tiny cost matters. */
  formatUsdPrecise(value: string): string;
  /** "2026-09-27" → "9/27" (en) / "27/9" (es). */
  formatShortDay(day: string): string;
  formatDateTime(iso: string): string;
  formatTime(iso: string): string;
  /** "Mon 09:00 AM" / "lun. 09:00": a moment within the next week (next opening). */
  formatWeekdayTime(iso: string): string;
  /** 0 = Sunday … 6 = Saturday → "Monday" / "lunes" (capitalized in both languages). */
  weekdayName(day: number): string;
  /** "Sep 28" / "28 set." (chart axes). */
  formatShortDate(iso: string | number): string;
  /** "Monday, September 28" / "lunes, 28 de septiembre" (chat day separators). */
  formatLongDay(iso: string): string;
  formatRelative(iso: string, now?: Date): string;
  /** THE number formatter: accepts Decimal strings (Intl formats them without a float). */
  formatNumber(value: string | number, options?: NumberOptions): string;
  /** A price without currency, as in a list: "1,850.00" / "1.850,00" (up to 4 decimals). */
  formatPrice(value: string): string;
  /** Signed percentage with UP TO one decimal: "+12.5%" / "+12,5 %", minus sign "−". */
  formatPct(value: string | number): string;
  /**
   * A Decimal string to pre-fill an editable price field, WITHOUT thousands separators (the
   * inputs refuse an ambiguous "1,850" / "1.850"): en "3325.36", es "3325,36".
   */
  toDecimalInput(value: string | null): string;
}

/** Intl puts a no-break space (U+00A0) before "%" and after "$" in es-UY: shown as a space. */
const NBSP = /\u00a0/g;

export function createFormat(locale: AppLocale): Formatter {
  const intl = INTL_LOCALE[locale];
  const integer = new Intl.NumberFormat(intl, { maximumFractionDigits: 0 });
  const dateTime = new Intl.DateTimeFormat(intl, {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const time = new Intl.DateTimeFormat(intl, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
  const weekdayTime = new Intl.DateTimeFormat(intl, {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const weekday = new Intl.DateTimeFormat(intl, { weekday: "long", timeZone: "UTC" });
  const shortDate = new Intl.DateTimeFormat(intl, {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
  });
  const longDay = new Intl.DateTimeFormat(intl, {
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const relative = RELATIVE[locale];

  const formatNumber: Formatter["formatNumber"] = (
    value,
    { minimumFractionDigits = 0, maximumFractionDigits = 2, grouping = true } = {},
  ) =>
    new Intl.NumberFormat(intl, {
      minimumFractionDigits,
      maximumFractionDigits,
      useGrouping: grouping,
    }).format(value as number);

  // ADR-035: US dollars are "$58.00" (en) / "US$ 58,00" (es); EVERY other currency shows its ISO code
  // in both languages ("CAD 79.90", "UYU 2.390,00"), so a peso or a Canadian dollar is never read as a US one.
  const formatMoney: Formatter["formatMoney"] = (value, currency, maximumFractionDigits = 2) => {
    const amount = value as unknown as number;
    return new Intl.NumberFormat(intl, {
      style: "currency",
      currency,
      currencyDisplay: currency === "USD" ? "symbol" : "code",
      maximumFractionDigits,
    })
      .format(amount)
      .replace(NBSP, " ");
  };

  return {
    locale,
    formatInt: (value) => integer.format(value),
    // Built by hand like formatPct: ICU versions disagree on the space before "%" in es-UY.
    formatRatio: (value) =>
      value === null
        ? "—"
        : `${integer.format(Math.round(value * 100))}${locale === "en" ? "%" : " %"}`,
    formatMoney,
    formatUsd: (value) => {
      const amount = Math.abs(Number(value));
      return formatMoney(value, "USD", amount > 0 && amount < 0.01 ? 4 : 2);
    },
    formatUsdPrecise: (value) => formatMoney(value, "USD", 4),
    formatShortDay(day) {
      const [, month, dayOfMonth] = day.split("-");
      const [m, d] = [Number(month), Number(dayOfMonth)];
      return locale === "en" ? `${m}/${d}` : `${d}/${m}`;
    },
    formatDateTime: (iso) => dateTime.format(new Date(iso)),
    formatTime: (iso) => time.format(new Date(iso)),
    formatWeekdayTime: (iso) => weekdayTime.format(new Date(iso)),
    formatShortDate: (iso) => shortDate.format(new Date(iso)),
    formatLongDay: (iso) => longDay.format(new Date(iso)),
    weekdayName(day) {
      // 2026-01-04 is a Sunday: day 0 → Sunday, 1 → Monday…
      const name = weekday.format(new Date(Date.UTC(2026, 0, 4 + day)));
      return name.charAt(0).toUpperCase() + name.slice(1);
    },
    formatRelative(iso, now = new Date()) {
      const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
      if (minutes < 1) return relative.now;
      if (minutes < 60) return relative.minutes(integer.format(minutes));
      const hours = Math.round(minutes / 60);
      if (hours < 24) return relative.hours(integer.format(hours));
      const days = Math.round(hours / 24);
      return days === 1 ? relative.yesterday : relative.days(integer.format(days));
    },
    formatNumber,
    formatPrice: (value) =>
      formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    formatPct(value) {
      const n = Number(value);
      const text = formatNumber(Math.abs(n), { maximumFractionDigits: 1 });
      const sign = n > 0 ? "+" : n < 0 ? "−" : "";
      return locale === "en" ? `${sign}${text}%` : `${sign}${text} %`;
    },
    toDecimalInput: (value) => (value ? (locale === "es" ? value.replace(".", ",") : value) : ""),
  };
}
