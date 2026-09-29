/**
 * What the panel needs to write an alert in ITS language (phase 13): a whitelist of the
 * structured payload fields per alert type. The stored `title` stays as a technical fallback
 * (older alerts, unknown shapes). Pure — unit tested. Never returns ids or anything else the
 * payload may carry.
 */

type Details = Record<string, string | number | null>;

const pick = (payload: Record<string, unknown>, keys: string[]): Details =>
  Object.fromEntries(
    keys.flatMap((k) => {
      const v = payload[k];
      return typeof v === "string" || typeof v === "number" || v === null ? [[k, v]] : [];
    }),
  );

const FIELDS: Record<string, string[]> = {
  price_change: ["oldPrice", "newPrice", "currency", "changePct"],
  low_stock: ["stock"],
  manual_attention: ["reason", "durationSeconds", "sizeBytes", "maxSeconds"],
  integration_error: ["reason", "workflow", "node", "message"],
  possible_opt_out: ["matched"],
};

export function alertDetails(type: string, payload: unknown): Details | null {
  const fields = FIELDS[type];
  if (!fields || typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  const details = pick(payload as Record<string, unknown>, fields);
  return Object.keys(details).length > 0 ? details : null;
}
