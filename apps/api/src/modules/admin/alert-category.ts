import type { AlertType } from "../../generated/prisma/enums.js";

/**
 * Panel triage of alerts (phase 15, ADR-032). Presentation only: it decides WHERE the panel shows
 * an alert, never what the system does (digests, notifications and every decision stay as they
 * are).
 * - action: waits for a person → the To do list and its single yellow counter (ADR-029).
 * - info: news about something already done → Activity, no yellow, nothing to acknowledge.
 * - technical: for whoever runs the system → System status (admins; read-only in the demo).
 *
 * Exhaustive on purpose: a new AlertType does not compile until it is classified here.
 * `missing_data` and `ingestion_error` are not created by any code today (enum values kept since
 * phase 2, no migration); they are classified so an old row or a future producer has a home —
 * whoever starts creating them revisits this table (ADR-032).
 */

export const ALERT_CATEGORIES = ["action", "info", "technical"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const ALERT_CATEGORY: Readonly<Record<AlertType, AlertCategory>> = {
  /** "Listen to this voice note by hand": nobody else will. Closed with "Done" (acknowledge). */
  manual_attention: "action",
  /** Ambiguous opt-out phrase: deliberately not applied, a person decides (ADR-017). */
  possible_opt_out: "action",
  /** Already applied; WhatsApp digests still notify it as before. */
  price_change: "info",
  /** Restocking happens outside the system: nothing to close in the panel. */
  low_stock: "info",
  /** Not produced today: missing fields become review items (missing_currency, uncertain_value). */
  missing_data: "info",
  /** n8n unreachable, workflow errors. */
  integration_error: "technical",
  /** Not produced today: a failed list reaches the business as the extraction_failed review. */
  ingestion_error: "technical",
};

export function alertCategory(type: AlertType): AlertCategory {
  return ALERT_CATEGORY[type];
}

/** The alert types of one category (for `where: { type: { in } }`). */
export function alertTypesIn(category: AlertCategory): AlertType[] {
  return (Object.keys(ALERT_CATEGORY) as AlertType[]).filter(
    (type) => ALERT_CATEGORY[type] === category,
  );
}
