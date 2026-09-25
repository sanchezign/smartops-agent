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
}

export function isActionableRun(facts: RunFacts): boolean {
  return facts.increasesOverThreshold > 0 || facts.lowStock > 0 || facts.pendingReviews > 0;
}

export type ItemData =
  | ({ category: "run_summary" } & RunFacts)
  | { category: "customer_query"; messageId: string; contactName: string | null; preview: string }
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

/**
 * One WhatsApp text for a digest: "SmartOps · 3 listas procesadas: 8 aumentos (2 mayores al
 * 10 %), 1 revisión pendiente. 2 consultas de clientes. Detalle en el panel."
 */
export function renderDigest(items: ItemData[]): string {
  const lines: string[] = [];
  const errors = items.filter((i) => i.category === "integration_error");
  for (const e of errors.slice(0, 3))
    lines.push(`⚠️ Error de integración (${e.source}): ${e.message}`);
  if (errors.length > 3) lines.push(`⚠️ y ${errors.length - 3} errores más.`);

  const runs = items.filter(
    (i): i is Extract<ItemData, { category: "run_summary" }> => i.category === "run_summary",
  );
  if (runs.length > 0) {
    const sum = (key: "increases" | "increasesOverThreshold" | "lowStock" | "pendingReviews") =>
      runs.reduce((total, r) => total + r[key], 0);
    const threshold = Math.min(...runs.map((r) => r.thresholdPct));
    const parts: string[] = [];
    const increases = sum("increases");
    const over = sum("increasesOverThreshold");
    if (increases > 0) {
      parts.push(
        over > 0
          ? `${plural(increases, "aumento", "aumentos")} (${over} mayor${over === 1 ? "" : "es"} al ${threshold} %)`
          : plural(increases, "aumento", "aumentos"),
      );
    }
    const low = sum("lowStock");
    if (low > 0) parts.push(plural(low, "producto con stock bajo", "productos con stock bajo"));
    const reviews = sum("pendingReviews");
    if (reviews > 0) parts.push(plural(reviews, "revisión pendiente", "revisiones pendientes"));
    lines.push(
      `${plural(runs.length, "lista procesada", "listas procesadas")}: ${parts.join(", ")}.`,
    );
  }

  const queries = items.filter((i) => i.category === "customer_query").length;
  if (queries > 0)
    lines.push(`${plural(queries, "consulta de cliente", "consultas de clientes")}.`);
  const manual = items.filter((i) => i.category === "manual_attention").length;
  if (manual > 0) lines.push(`${plural(manual, "audio para escuchar", "audios para escuchar")}.`);

  return `SmartOps · ${lines.join(" ")} Detalle en el panel.`.slice(0, 1024);
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
