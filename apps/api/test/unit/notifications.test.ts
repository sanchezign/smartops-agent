import { describe, expect, it } from "vitest";
import {
  isActionableRun,
  nextAllowedSend,
  renderDigest,
  runTitle,
  type ItemData,
  type RunFacts,
} from "../../src/modules/notifications/digest-rules.js";
import { ackText } from "../../src/modules/notifications/supplier-ack.js";

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  runId: "r",
  supplierName: "Distribuidora Ejemplo",
  increases: 0,
  increasesOverThreshold: 0,
  thresholdPct: 10,
  lowStock: 0,
  pendingReviews: 0,
  ...over,
});
const item = (facts: RunFacts): ItemData => ({ category: "run_summary", ...facts });

describe("what is actionable (anti-spam)", () => {
  it("increases over the threshold, low stock or pending reviews notify; anything else does not", () => {
    expect(isActionableRun(run())).toBe(false);
    expect(isActionableRun(run({ increases: 5 }))).toBe(false); // small increases: panel only
    expect(isActionableRun(run({ increases: 5, increasesOverThreshold: 1 }))).toBe(true);
    expect(isActionableRun(run({ lowStock: 1 }))).toBe(true);
    expect(isActionableRun(run({ pendingReviews: 1 }))).toBe(true);
  });

  it("the panel title describes the run", () => {
    expect(runTitle(run({ increases: 5, increasesOverThreshold: 2, pendingReviews: 1 }))).toBe(
      "Distribuidora Ejemplo: 5 aumentos (2 mayores al 10 %), 1 revisión pendiente",
    );
  });
});

describe("digest text (one WhatsApp for many events)", () => {
  it("groups the lists of the window like the user's example", () => {
    const text = renderDigest([
      item(run({ increases: 3, increasesOverThreshold: 1 })),
      item(run({ increases: 5, increasesOverThreshold: 1, pendingReviews: 1 })),
      item(run({ pendingReviews: 0, lowStock: 0, increases: 0 })),
    ]);
    expect(text).toBe(
      "SmartOps · 3 listas procesadas: 8 aumentos (2 mayores al 10 %), 1 revisión pendiente. Detalle en el panel.",
    );
  });

  it("adds customer queries, audios to listen to and integration errors (errors first)", () => {
    const text = renderDigest([
      item(run({ lowStock: 1 })),
      { category: "customer_query", messageId: "m", contactName: "Ana", preview: "¿precio?" },
      { category: "customer_query", messageId: "m2", contactName: null, preview: "¿stock?" },
      { category: "manual_attention", title: "Audio de 4:12" },
      { category: "integration_error", source: "n8n · procesador", message: "timeout" },
    ]);
    expect(text).toBe(
      "SmartOps · ⚠️ Error de integración (n8n · procesador): timeout 1 lista procesada: 1 producto con stock bajo. 2 consultas de clientes. 1 audio para escuchar. Detalle en el panel.",
    );
  });
});

describe("hourly cap", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  it("under the cap → send now; at the cap → when the oldest send leaves the hour", () => {
    expect(nextAllowedSend([ago(50), ago(10)], 3, now)).toBeNull();
    expect(nextAllowedSend([ago(50), ago(30), ago(10)], 3, now)).toEqual(ago(50 - 60));
    expect(nextAllowedSend([ago(90), ago(10)], 2, now)).toBeNull(); // 90 min ago is outside
  });
});

describe("supplier acknowledgement text", () => {
  const ctx = {
    status: "ingested",
    counts: { updated: 5, created: 1 },
    pendingReviews: 1,
    contactKind: "supplier",
    conversationId: "c",
    conversationMode: "bot",
  };
  it("summarizes what was applied, never prices or product names", () => {
    expect(ackText(ctx)).toBe(
      "¡Gracias! Recibimos tu lista: 5 precios actualizados, 1 producto nuevo. Un punto queda para revisión de nuestro equipo.",
    );
    expect(ackText({ ...ctx, counts: { updated: 0 }, pendingReviews: 0 })).toBe(
      "¡Gracias! Recibimos tu lista; no hubo cambios de precio.",
    );
    expect(ackText({ ...ctx, status: "needs_review" })).toMatch(/nuestro equipo lo revisa/);
  });
});
