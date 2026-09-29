/**
 * Business hours editor model (phase 9 M6): one row per weekday ↔ the `businessHours` setting
 * ({ timeZone, days: [{ day, open, close }] }, day 0 = Sunday). Pure; day names come from the
 * formatter in the panel language (phase 13).
 */

import type { InputError } from "@/lib/number-input";

export interface BusinessHours {
  timeZone: string;
  days: { day: number; open: string; close: string }[];
}

export interface DayRow {
  day: number;
  enabled: boolean;
  open: string;
  close: string;
}

export const DEFAULT_TIME_ZONE = "America/Montevideo";
/** Monday first, like a Uruguayan week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function toRows(hours: BusinessHours | null): DayRow[] {
  return WEEK_ORDER.map((day) => {
    const rule = hours?.days.find((d) => d.day === day);
    return rule
      ? { day, enabled: true, open: rule.open, close: rule.close }
      : { day, enabled: false, open: "09:00", close: day === 6 ? "13:00" : "18:00" };
  });
}

export function fromRows(
  rows: DayRow[],
  timeZone = DEFAULT_TIME_ZONE,
): { ok: true; value: BusinessHours } | { ok: false; error: InputError } {
  const days = rows.filter((r) => r.enabled);
  for (const r of days) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.close))
      return { ok: false, error: { code: "hoursFormat", params: { day: r.day } } };
    if (r.open === r.close)
      return { ok: false, error: { code: "hoursEqual", params: { day: r.day } } };
  }
  return {
    ok: true,
    value: { timeZone, days: days.map(({ day, open, close }) => ({ day, open, close })) },
  };
}
