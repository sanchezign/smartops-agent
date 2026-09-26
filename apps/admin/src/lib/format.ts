/**
 * Formatting for the panel (phase 9): es-UY, America/Montevideo. Money and percentages come
 * from the API as Decimal STRINGS — they are only formatted here, never used for arithmetic.
 */

export const TIME_ZONE = "America/Montevideo";
const LOCALE = "es-UY";

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0 });

export function formatInt(value: number): string {
  return integer.format(value);
}

/** 0.826 → "83 %"; null → "—". */
export function formatRatio(value: number | null): string {
  return value === null ? "—" : percent.format(value).replace(/ /g, " ");
}

/**
 * Money from a Decimal string ("1234.5") — Intl formats the string without going through a
 * binary float (Intl.NumberFormat accepts numeric strings).
 */
export function formatMoney(value: string, currency: string, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    maximumFractionDigits,
  })
    .format(value as unknown as number)
    .replace(/ /g, " ");
}

/** USD with up to 4 decimals (AI costs are cents). */
export function formatUsd(value: string): string {
  return formatMoney(value, "USD", 4);
}

/** "2026-09-27" → "27/9". */
export function formatShortDay(day: string): string {
  const [, month, dayOfMonth] = day.split("-");
  return `${Number(dayOfMonth)}/${Number(month)}`;
}

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const time = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** "hace 5 min", "hace 3 h", "hace 2 días" — relative to `now`. */
export function formatRelative(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "ayer" : `hace ${days} días`;
}

/**
 * THE number formatter of the panel: es-UY (comma decimals, dot thousands: "1.850,5").
 * Accepts Decimal strings from the API (Intl formats them without a binary float).
 */
export function formatNumber(
  value: string | number,
  { minimumFractionDigits = 0, maximumFractionDigits = 2, grouping = true } = {},
): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits,
    maximumFractionDigits,
    useGrouping: grouping,
  }).format(value as number);
}

/** A price without currency, as in a list: "1.850,00", "262,30" (up to 4 decimals). */
export function formatPrice(value: string): string {
  return formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/**
 * Signed percentage with UP TO one decimal: "+85 %", "+12,5 %", "−7,5 %" (the stored value
 * keeps all its decimals; this is display only).
 */
export function formatPct(value: string | number): string {
  const n = Number(value);
  const text = formatNumber(Math.abs(n), { maximumFractionDigits: 1 });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text} %`;
}

/**
 * A Decimal string to pre-fill an editable price field: comma decimals and NO thousands dot
 * ("3325.36" → "3325,36"), because the input refuses an ambiguous "1.850".
 */
export function toDecimalInput(value: string | null): string {
  return value ? value.replace(".", ",") : "";
}
