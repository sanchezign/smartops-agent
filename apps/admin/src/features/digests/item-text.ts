/**
 * A WhatsApp-digest item described for the panel (phase 13): the structured `data` the API
 * stored, reduced to what the screen writes in the panel language. null = show the stored title
 * (items of an unknown shape). Pure — unit tested.
 */

export type DigestItemView =
  | {
      kind: "run";
      supplier: string | null;
      increases: number;
      over: number;
      thresholdPct: number;
      lowStock: number;
      reviews: number;
    }
  | { kind: "order" | "query"; name: string | null; preview: string }
  | { kind: "error"; source: string; message: string }
  | { kind: "audio"; seconds: number | null; sizeBytes: number | null; maxSeconds: number | null };

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function digestItemView(data: unknown): DigestItemView | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  switch (d.category) {
    case "run_summary":
      return {
        kind: "run",
        supplier: str(d.supplierName),
        increases: num(d.increases) ?? 0,
        over: num(d.increasesOverThreshold) ?? 0,
        thresholdPct: num(d.thresholdPct) ?? 0,
        lowStock: num(d.lowStock) ?? 0,
        reviews: num(d.pendingReviews) ?? 0,
      };
    case "order":
    case "customer_query":
      return {
        kind: d.category === "order" ? "order" : "query",
        name: str(d.contactName),
        preview: str(d.preview) ?? "",
      };
    case "integration_error":
      return { kind: "error", source: str(d.source) ?? "", message: str(d.message) ?? "" };
    case "manual_attention":
      return d.reason === "audio_too_long"
        ? {
            kind: "audio",
            seconds: num(d.durationSeconds),
            sizeBytes: num(d.sizeBytes),
            maxSeconds: num(d.maxSeconds),
          }
        : null;
    default:
      return null;
  }
}
