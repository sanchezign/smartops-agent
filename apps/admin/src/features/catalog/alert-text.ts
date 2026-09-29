import type { Formatter } from "@/lib/format";
import type { AlertItem } from "./types";

/**
 * An alert written in the panel language (phase 13) from its structured `details`; null = use
 * the stored title (older alerts, unknown shapes). Pure — unit tested. Returns an "alerts.titles"
 * message key and its already formatted params.
 */

export type AlertTitleKey =
  | "priceChange"
  | "lowStock"
  | "audioTooLong"
  | "audioTooLongSize"
  | "n8nDeliveryFailed"
  | "n8nWorkflowError"
  | "possibleOptOut";

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);

export function alertText(
  alert: Pick<AlertItem, "type" | "details" | "product">,
  format: Formatter,
): { key: AlertTitleKey; params: Record<string, string> } | null {
  const d = alert.details;
  if (!d) return null;
  const product = alert.product?.name ?? null;
  switch (alert.type) {
    case "price_change": {
      const [oldPrice, newPrice, currency, pct] = [
        str(d.oldPrice),
        str(d.newPrice),
        str(d.currency),
        str(d.changePct),
      ];
      if (!product || !oldPrice || !newPrice || !currency || !pct) return null;
      return {
        key: "priceChange",
        params: {
          product,
          oldPrice: format.formatMoney(oldPrice, currency),
          newPrice: format.formatMoney(newPrice, currency),
          pct: format.formatPct(pct),
        },
      };
    }
    case "low_stock": {
      const stock = num(d.stock);
      if (!product || stock === null) return null;
      return { key: "lowStock", params: { product, stock: format.formatInt(stock) } };
    }
    case "manual_attention": {
      if (d.reason !== "audio_too_long") return null;
      const max = num(d.maxSeconds);
      const limit = max === null ? "?" : format.formatInt(Math.round(max / 60));
      const seconds = num(d.durationSeconds);
      if (seconds !== null) {
        const s = Math.round(seconds);
        return {
          key: "audioTooLong",
          params: { length: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, limit },
        };
      }
      const bytes = num(d.sizeBytes);
      return {
        key: "audioTooLongSize",
        params: {
          size:
            bytes === null
              ? "?"
              : format.formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 1 }),
          limit,
        },
      };
    }
    case "integration_error": {
      if (d.reason === "n8n_delivery_failed") return { key: "n8nDeliveryFailed", params: {} };
      if (d.reason === "n8n_workflow_error") {
        const where = [str(d.workflow), str(d.node)].filter(Boolean).join(" · ");
        return {
          key: "n8nWorkflowError",
          params: { where: where || "n8n", message: str(d.message) ?? "" },
        };
      }
      return null;
    }
    case "possible_opt_out": {
      const matched = str(d.matched);
      return matched ? { key: "possibleOptOut", params: { phrase: matched } } : null;
    }
    default:
      return null;
  }
}
