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

/** Signed percentage for people: "+85 %", "−7,5 %" (the stored value keeps its decimals). */
export function formatPct(value: string | number): string {
  const n = Number(value);
  const text = new Intl.NumberFormat("es-UY", { maximumFractionDigits: 1 }).format(Math.abs(n));
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text} %`;
}
