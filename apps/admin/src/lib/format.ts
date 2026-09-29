/**
 * Formatting for the panel (phase 9; per language since phase 13). Numbers and dates follow the
 * PANEL language: en → en-US ("$1,850.00", "Sep 28"), es → es-UY ("$ 1.850,00", "28 set.").
 * Time zone is always the business's (America/Montevideo). Money and percentages come from the
 * API as Decimal STRINGS — they are only formatted here, never used for arithmetic.
 *
 * Currency symbols (both languages): "$" always means the business currency (UYU, as es-UY
 * shows it), USD is "US$", anything else its ISO code — so two currencies never share "$".
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
  /** USD with up to 4 decimals (AI costs are cents). */
  formatUsd(value: string): string;
  /** "2026-09-27" → "9/27" (en) / "27/9" (es). */
  formatShortDay(day: string): string;
  formatDateTime(iso: string): string;
  formatTime(iso: string): string;
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

  const formatMoney: Formatter["formatMoney"] = (value, currency, maximumFractionDigits = 2) => {
    const amount = value as unknown as number;
    if (locale === "es") {
      return new Intl.NumberFormat(intl, { style: "currency", currency, maximumFractionDigits })
        .format(amount)
        .replace(NBSP, " ");
    }
    // en: the es-UY symbol ("$" UYU, "US$" USD, else the code) on en-US digits.
    const symbol =
      new Intl.NumberFormat(INTL_LOCALE.es, { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currency;
    if (/^[A-Z]{3}$/.test(symbol)) {
      return new Intl.NumberFormat(intl, { style: "currency", currency, maximumFractionDigits })
        .format(amount)
        .replace(NBSP, " ");
    }
    return new Intl.NumberFormat(intl, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits,
    })
      .formatToParts(amount)
      .map((p) => (p.type === "currency" ? symbol : p.value))
      .join("");
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
    formatUsd: (value) => formatMoney(value, "USD", 4),
    formatShortDay(day) {
      const [, month, dayOfMonth] = day.split("-");
      const [m, d] = [Number(month), Number(dayOfMonth)];
      return locale === "en" ? `${m}/${d}` : `${d}/${m}`;
    },
    formatDateTime: (iso) => dateTime.format(new Date(iso)),
    formatTime: (iso) => time.format(new Date(iso)),
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

/**
 * Spanish bindings kept while phase 13 M2 moves every component to `useFormat()`.
 * @deprecated use `useFormat()` in components or a `Formatter` in pure code.
 */
const es = createFormat("es");
export const {
  formatInt,
  formatRatio,
  formatMoney,
  formatUsd,
  formatShortDay,
  formatDateTime,
  formatTime,
  formatRelative,
  formatNumber,
  formatPrice,
  formatPct,
  toDecimalInput,
} = es;
