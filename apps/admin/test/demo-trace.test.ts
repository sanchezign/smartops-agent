import { describe, expect, it } from "vitest";
import { timeline, type DemoTrace } from "../src/features/demo/trace";

/** "Try the system" timeline (phase 9 M8): message keys since phase 13. */

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
    expect(view.steps[0]).toEqual({ key: "received", state: "active" });
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
      key: "updated",
      counts: { prices: 5, created: 0, reviews: 0 },
      href: "/catalogo",
      linkKey: "viewCatalog",
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
    expect(injection.steps.at(-1)).toEqual({ key: "held", state: "held" });
    expect(injection.outcome!.tone).toBe("review");
    expect(injection.outcome!.key).toBe("suspicious");
    const sheet = timeline("planilla_nueva", {
      received: true,
      message: { ...message, type: "document" },
      media: { status: "stored", transcription: null, conversion: "done" },
      run: run({ status: "needs_review", reason: "column_mapping_required" }),
    });
    expect(sheet.outcome).toMatchObject({
      key: "newFormat",
      linkKey: "pickColumn",
      tone: "review",
    });
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

  it("processed without changes says so (no counts)", () => {
    const view = timeline("pdf", {
      received: true,
      message: { ...message, type: "document" },
      media: { status: "stored", transcription: null, conversion: null },
      run: run({}),
    });
    expect(view.outcome).toMatchObject({ key: "noChanges", tone: "success" });
    expect(view.outcome!.counts).toBeUndefined();
  });
});
