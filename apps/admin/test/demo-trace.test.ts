import { describe, expect, it } from "vitest";
import { timeline, type DemoTrace } from "../src/features/demo/trace";

/** "Probar el sistema" timeline (phase 9 M8). */

const message = { id: "m", conversationId: "c", type: "image" };
const run = (over: Partial<NonNullable<DemoTrace["run"]>>) => ({
  id: "r",
  status: "ingested",
  classification: "price_update_partial",
  prefilterRule: null,
  reason: null,
  priceChanges: 0,
  createdProducts: 0,
  pendingReviews: 0,
  ...over,
});

describe("timeline", () => {
  it("nothing yet: the first step is in progress", () => {
    const view = timeline("foto", null);
    expect(view.steps[0]).toEqual({ label: expect.stringMatching(/WhatsApp/), state: "active" });
    expect(view.finished).toBe(false);
  });

  it("a photo that updated prices ends in the catalog", () => {
    const view = timeline("foto", {
      received: true,
      message,
      media: { status: "stored", transcription: null, conversion: null },
      run: run({ priceChanges: 5, pendingReviews: 0 }),
    });
    expect(view.steps.every((s) => s.state === "done")).toBe(true);
    expect(view.outcome).toMatchObject({
      text: "Catálogo al día: 5 precios actualizados.",
      href: "/catalogo",
    });
  });

  it("a voice note with a doubtful value goes to review; the audio step needs the transcript", () => {
    const waiting = timeline("audio", {
      received: true,
      message,
      media: { status: "stored", transcription: "pending", conversion: null },
      run: null,
    });
    expect(waiting.steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "active",
      "waiting",
      "waiting",
    ]);
    const done = timeline("audio", {
      received: true,
      message,
      media: { status: "stored", transcription: "done", conversion: null },
      run: run({ pendingReviews: 1 }),
    });
    expect(done.outcome).toMatchObject({ tone: "review", href: "/revisiones" });
  });

  it("prompt injection and a new spreadsheet format stop with their own explanation", () => {
    const injection = timeline("injection", {
      received: true,
      message: { ...message, type: "text" },
      media: null,
      run: run({ status: "needs_review", reason: "suspicious_instructions" }),
    });
    // Stopped ON PURPOSE: amber "held", never the red failure state.
    expect(injection.steps.at(-1)).toEqual({ label: "Frenado para revisión", state: "held" });
    expect(injection.outcome!.tone).toBe("review");
    expect(injection.outcome!.text).toMatch(/órdenes al sistema/);
    const sheet = timeline("planilla_nueva", {
      received: true,
      message: { ...message, type: "document" },
      media: { status: "stored", transcription: null, conversion: "done" },
      run: run({ status: "needs_review", reason: "column_mapping_required" }),
    });
    expect(sheet.outcome).toMatchObject({ linkText: "Elegir la columna", tone: "review" });
    expect(sheet.steps.at(-1)!.state).toBe("held");
  });

  it("only a real failure is red", () => {
    const failed = timeline("pdf", {
      received: true,
      message: { ...message, type: "document" },
      media: { status: "stored", transcription: null, conversion: null },
      run: run({ status: "failed" }),
    });
    expect(failed.steps.at(-1)!.state).toBe("failed");
    expect(failed.outcome!.tone).toBe("failed");
  });
});
