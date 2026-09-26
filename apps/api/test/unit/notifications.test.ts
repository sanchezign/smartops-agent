import { describe, expect, it } from "vitest";
import {
  isActionableRun,
  nextAllowedSend,
  neutralize,
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

describe("digest text (phase 9 M7: one WhatsApp, a little context per item)", () => {
  const LINK = "https://panel.example.uy/d/" + "x".repeat(43);
  const tornillo = {
    productName: "Tornillo 6mm",
    oldPrice: "12",
    newPrice: "14",
    currency: "UYU",
    changePct: "16.6667",
  };

  it("headline with counts, one line per item with the main change, and the panel link", () => {
    const text = renderDigest(
      [
        item(
          run({ increases: 3, increasesOverThreshold: 1, pendingReviews: 1, mainChange: tornillo }),
        ),
        { category: "order", messageId: "o1", contactName: "Luis", preview: "necesito 3 macetas" },
      ],
      { link: LINK },
    );
    expect(text).toBe(
      [
        "SmartOps · 1 pedido · 1 lista",
        "• Pedido de Luis: «necesito 3 macetas»",
        "• Distribuidora Ejemplo: Tornillo 6mm $ 12,00 → $ 14,00 (+16,7 %), 2 aumentos más, 1 revisión pendiente",
        `Ver en el panel: ${LINK}`,
      ].join("\n"),
    );
  });

  it("errors first, then orders, queries, lists, audios; at most 5 lines and '+N más'", () => {
    const items: ItemData[] = [
      item(run({ lowStock: 1 })),
      { category: "manual_attention", title: "Audio de 4:12 de Pinturas del Sur" },
      ...Array.from({ length: 5 }, (_, i): ItemData => ({
        category: "customer_query",
        messageId: `q${i}`,
        contactName: `Cliente ${i}`,
        preview: "¿tienen stock?",
      })),
      { category: "integration_error", source: "n8n · procesador", message: "timeout" },
    ];
    const lines = renderDigest(items).split("\n");
    expect(lines[0]).toBe("SmartOps · ⚠️ 1 error · 5 consultas · 1 lista · 1 audio para escuchar");
    expect(lines[1]).toBe("• ⚠️ Error (n8n · procesador): timeout");
    expect(lines.filter((l) => l.startsWith("• "))).toHaveLength(6); // 5 details + "+N más"
    expect(lines.at(-2)).toBe("• +3 más en el panel");
    expect(lines.at(-1)).toBe("Detalle en el panel.");
  });

  it("snippets are truncated and neutralized: no links, no formatting marks, no line breaks", () => {
    const text = renderDigest([
      {
        category: "customer_query",
        messageId: "q",
        contactName: "*Juan*\nPérez",
        preview:
          "Mirá https://phish.example/login y *pagá* ya‮ — ~oferta~ `x` " + "muy ".repeat(20),
      },
    ]);
    const line = text.split("\n")[1]!;
    expect(line).not.toMatch(/https?:|phish|[*~`‮]/);
    expect(line).toContain("[enlace]");
    expect(line.startsWith("• Consulta de Juan Pérez: «Mirá [enlace] y pagá ya")).toBe(true);
    expect(line.endsWith("…»")).toBe(true);
  });

  it("template variant is a single line (WhatsApp forbids line breaks in parameters)", () => {
    const text = renderDigest(
      [{ category: "order", messageId: "o", contactName: "Ana", preview: "mandame tanza" }],
      { link: LINK, singleLine: true },
    );
    expect(text).not.toContain("\n");
    expect(text).toBe(
      `SmartOps · 1 pedido · Pedido de Ana: «mandame tanza» · Ver en el panel: ${LINK}`,
    );
  });

  it("never exceeds 1,024 chars and never cuts the link: drops detail lines instead", () => {
    const many: ItemData[] = Array.from({ length: 40 }, (_, i) => ({
      category: "order",
      messageId: `o${i}`,
      contactName: "N".repeat(60),
      preview: "p".repeat(200),
    }));
    const text = renderDigest(many, { link: LINK });
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text.endsWith(LINK)).toBe(true);
    expect(text).toMatch(/\+\d+ más en el panel/);
  });

  it("neutralize() keeps plain text and cuts with an ellipsis", () => {
    expect(neutralize("  hola\n\tche  ", 20)).toBe("hola che");
    expect(neutralize("abcdefghij", 5)).toBe("abcd…");
    expect(neutralize(null, 5)).toBe("");
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
    conversationMode: "bot" as const,
    humanUntil: null,
    modeChangedAt: null,
    messageReceivedAt: new Date(),
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
