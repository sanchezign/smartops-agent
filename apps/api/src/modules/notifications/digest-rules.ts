/**
 * Notification rules (pure, phase 6). Anti-spam (user rule): only ACTIONABLE events are
 * notified; a run without news stays in the panel. WhatsApp recipients get ONE message per
 * digest window, capped per hour; critical errors skip the window with their own cap.
 */

export interface RunFacts {
  runId: string;
  supplierName: string | null;
  increases: number;
  increasesOverThreshold: number;
  thresholdPct: number;
  lowStock: number;
  pendingReviews: number;
  /** The biggest price change of the run (phase 9 M7); absent in digests recorded before. */
  mainChange?: {
    productName: string;
    oldPrice: string;
    newPrice: string;
    currency: string;
    changePct: string;
  } | null;
}

export function isActionableRun(facts: RunFacts): boolean {
  return facts.increasesOverThreshold > 0 || facts.lowStock > 0 || facts.pendingReviews > 0;
}

export type ItemData =
  | ({ category: "run_summary" } & RunFacts)
  | { category: "customer_query"; messageId: string; contactName: string | null; preview: string }
  | { category: "order"; messageId: string; contactName: string | null; preview: string }
  | { category: "integration_error"; source: string; message: string }
  | { category: "manual_attention"; title: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function runTitle(facts: RunFacts): string {
  const parts: string[] = [];
  if (facts.increases > 0) {
    parts.push(
      facts.increasesOverThreshold > 0
        ? `${plural(facts.increases, "aumento", "aumentos")} (${facts.increasesOverThreshold} mayor${facts.increasesOverThreshold === 1 ? "" : "es"} al ${facts.thresholdPct} %)`
        : plural(facts.increases, "aumento", "aumentos"),
    );
  }
  if (facts.lowStock > 0)
    parts.push(plural(facts.lowStock, "producto con stock bajo", "productos con stock bajo"));
  if (facts.pendingReviews > 0)
    parts.push(plural(facts.pendingReviews, "revisión pendiente", "revisiones pendientes"));
  return `${facts.supplierName ?? "Lista procesada"}: ${parts.join(", ")}`;
}

/** Max detail lines in one digest; the rest is "+N más en el panel" (user rule: few lines). */
export const DIGEST_MAX_LINES = 5;
const SNIPPET_CHARS = 60;
const NAME_CHARS = 40;
const DIGEST_MAX_CHARS = 1024;

/**
 * Text written by a contact (or a supplier name) → safe to quote to the team: control chars
 * and line breaks removed, links replaced (never a clickable URL from a stranger), WhatsApp
 * formatting marks (* _ ~ `) and our quote marks stripped, truncated with "…".
 */
export function neutralize(text: string | null | undefined, max: number): string {
  const clean = (text ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[enlace]")
    .replace(/[*_~`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const money = (value: string, currency: string) => {
  try {
    return new Intl.NumberFormat("es-UY", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    })
      .format(value as unknown as number)
      .replace(/\s/g, " ");
  } catch {
    return `${value} ${currency}`;
  }
};
const pct = (value: string) => {
  const n = Number(value);
  const text = new Intl.NumberFormat("es-UY", { maximumFractionDigits: 1 }).format(Math.abs(n));
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text} %`;
};

type Line = { priority: number; text: string };

function runLine(run: Extract<ItemData, { category: "run_summary" }>): string {
  const supplier = neutralize(run.supplierName ?? "Lista procesada", NAME_CHARS);
  const parts: string[] = [];
  const main = run.mainChange;
  if (main) {
    parts.push(
      `${neutralize(main.productName, NAME_CHARS)} ${money(main.oldPrice, main.currency)} → ${money(main.newPrice, main.currency)} (${pct(main.changePct)})`,
    );
    const others = run.increases - (Number(main.changePct) > 0 ? 1 : 0);
    if (others > 0) parts.push(`${plural(others, "aumento más", "aumentos más")}`);
  } else if (run.increases > 0) {
    parts.push(plural(run.increases, "aumento", "aumentos"));
  }
  if (run.lowStock > 0)
    parts.push(plural(run.lowStock, "producto con stock bajo", "productos con stock bajo"));
  if (run.pendingReviews > 0)
    parts.push(plural(run.pendingReviews, "revisión pendiente", "revisiones pendientes"));
  return `${supplier}: ${parts.join(", ")}`;
}

function detailLines(items: ItemData[]): Line[] {
  return items.map((i): Line => {
    switch (i.category) {
      case "integration_error":
        return {
          priority: 0,
          text: `⚠️ Error (${neutralize(i.source, NAME_CHARS)}): ${neutralize(i.message, 80)}`,
        };
      case "order":
        return {
          priority: 1,
          text: `Pedido de ${neutralize(i.contactName ?? "un contacto", NAME_CHARS)}: «${neutralize(i.preview, SNIPPET_CHARS)}»`,
        };
      case "customer_query":
        return {
          priority: 2,
          text: `Consulta de ${neutralize(i.contactName ?? "un contacto", NAME_CHARS)}: «${neutralize(i.preview, SNIPPET_CHARS)}»`,
        };
      case "run_summary":
        return { priority: 3, text: runLine(i) };
      case "manual_attention":
        return { priority: 4, text: `🎧 ${neutralize(i.title, 90)}` };
    }
  });
}

function headline(items: ItemData[]): string {
  const count = (category: ItemData["category"]) =>
    items.filter((i) => i.category === category).length;
  const parts = [
    count("integration_error") > 0
      ? `⚠️ ${plural(count("integration_error"), "error", "errores")}`
      : null,
    count("order") > 0 ? plural(count("order"), "pedido", "pedidos") : null,
    count("customer_query") > 0 ? plural(count("customer_query"), "consulta", "consultas") : null,
    count("run_summary") > 0 ? plural(count("run_summary"), "lista", "listas") : null,
    count("manual_attention") > 0
      ? plural(count("manual_attention"), "audio para escuchar", "audios para escuchar")
      : null,
  ].filter(Boolean);
  return `SmartOps · ${parts.join(" · ")}`;
}

/**
 * One WhatsApp text per digest (phase 9 M7, user: a little context per item, still ONE
 * message): a headline with counts, up to DIGEST_MAX_LINES detail lines (errors, orders,
 * queries, lists, audios — in that order) with neutralized snippets, "+N más" and the panel
 * link (/d/<random token>: no content in the URL, login required).
 *
 * singleLine: for a template body parameter (WhatsApp does not allow line breaks there).
 */
export function renderDigest(
  items: ItemData[],
  options: { link?: string | null; singleLine?: boolean } = {},
): string {
  const details = detailLines(items).sort((a, b) => a.priority - b.priority);
  const shown = details.slice(0, DIGEST_MAX_LINES).map((l) => l.text);
  const rest = details.length - shown.length;
  const footer = options.link ? `Ver en el panel: ${options.link}` : "Detalle en el panel.";
  const build = (lines: string[], extra: number) => {
    const body = [...lines, ...(extra > 0 ? [`+${extra} más en el panel`] : [])];
    return options.singleLine
      ? [headline(items), ...body, footer].join(" · ")
      : [headline(items), ...body.map((l) => `• ${l}`), footer].join("\n");
  };
  // Keep within the limit by dropping detail lines (never cutting the link in half).
  let count = shown.length;
  let text = build(shown, rest);
  while (text.length > DIGEST_MAX_CHARS && count > 0) {
    count -= 1;
    text = build(shown.slice(0, count), details.length - count);
  }
  return text.length > DIGEST_MAX_CHARS
    ? `${headline(items)} · ${footer}`.slice(0, DIGEST_MAX_CHARS)
    : text;
}

/**
 * Hourly cap: when `sentAt` (sends of the last hour, any order) already reached the cap,
 * the digest waits until the oldest of them leaves the window. Null = can send now.
 */
export function nextAllowedSend(sentAt: Date[], cap: number, now: Date): Date | null {
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const recent = sentAt
    .filter((d) => d.getTime() > hourAgo)
    .sort((a, b) => a.getTime() - b.getTime());
  if (recent.length < cap) return null;
  return new Date(recent[recent.length - cap]!.getTime() + 60 * 60 * 1000);
}
