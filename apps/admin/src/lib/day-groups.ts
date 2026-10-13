import { TIME_ZONE } from "./format";

/**
 * Items grouped by the business's local day (phase 15 M4, Activity): "today", "yesterday" or the
 * date, newest day first, keeping the order of the items inside each day. Pure — unit tested.
 * Days are in the panel's time zone (format.ts), never the browser's.
 */

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE });

/** "2026-10-12": the local day of an instant. */
export const localDay = (at: string | Date) => dayFormat.format(new Date(at));

/** The local day before `day` ("2026-10-01" → "2026-09-30"). Calendar arithmetic, no time zone. */
export function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export type DayLabel = { kind: "today" } | { kind: "yesterday" } | { kind: "date"; at: string };

export interface DayGroup<T> {
  day: string;
  label: DayLabel;
  items: T[];
}

export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => string,
  now: Date = new Date(),
): DayGroup<T>[] {
  const today = localDay(now);
  const yesterday = previousDay(today);
  const groups = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const day = localDay(at(item));
    let group = groups.get(day);
    if (!group) {
      const label: DayLabel =
        day === today
          ? { kind: "today" }
          : day === yesterday
            ? { kind: "yesterday" }
            : { kind: "date", at: at(item) };
      group = { day, label, items: [] };
      groups.set(day, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day));
}
