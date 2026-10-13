import { DASHBOARD_TIME_ZONE } from "../dashboard/dashboard-rules.js";

/**
 * When the demo seed's recent news happen (phase 15): Activity must show them under "Today" and
 * "Yesterday" whatever the hour the seed runs — also right after midnight. Pure — unit tested.
 * - today:     max(start of the local day, now − 1 h) — never before midnight, never in the future;
 * - yesterday: noon of the previous local day.
 * Days are the business's (the panel's and the dashboard's time zone).
 */

const HOUR = 3_600_000;

/** The instant the local day of `now` started, in `timeZone`. */
export function localDayStart(now: Date, timeZone = DASHBOARD_TIME_ZONE): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  // The local wall clock read as if it were UTC, minus the real instant = the zone's offset.
  const wall = Date.UTC(
    y,
    m - 1,
    d,
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(y, m - 1, d) - offset);
}

export function recentNewsTimes(
  now: Date,
  timeZone = DASHBOARD_TIME_ZONE,
): { today: Date; yesterday: Date } {
  const start = localDayStart(now, timeZone);
  return {
    today: new Date(Math.max(start.getTime(), now.getTime() - HOUR)),
    yesterday: new Date(start.getTime() - 12 * HOUR),
  };
}
