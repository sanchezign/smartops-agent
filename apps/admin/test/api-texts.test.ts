import { describe, expect, it } from "vitest";
import { alertText } from "../src/features/catalog/alert-text";
import { digestItemView } from "../src/features/digests/item-text";
import { userErrorKey } from "../src/features/users/errors";
import { ApiError } from "../src/lib/api-client";
import { createFormat } from "../src/lib/format";

/** Texts the API used to compose, written by the panel in its own language (phase 13 M3). */

const en = createFormat("en");
const es = createFormat("es");
const product = { id: "p", name: "Tornillo 6mm" };

describe("alertText", () => {
  it("price change: money and percentage in the panel language", () => {
    const alert = {
      type: "price_change" as const,
      product,
      details: { oldPrice: "12", newPrice: "14", currency: "UYU", changePct: "16.6667" },
    };
    expect(alertText(alert, en)).toEqual({
      key: "priceChange",
      params: {
        product: "Tornillo 6mm",
        oldPrice: "UYU 12.00",
        newPrice: "UYU 14.00",
        pct: "+16.7%",
      },
    });
    expect(alertText(alert, es)?.params).toMatchObject({ oldPrice: "$ 12,00", pct: "+16,7 %" });
  });

  it("low stock, long voice notes (duration or size), n8n errors, possible opt-out", () => {
    expect(alertText({ type: "low_stock", product, details: { stock: 1200 } }, en)).toEqual({
      key: "lowStock",
      params: { product: "Tornillo 6mm", stock: "1,200" },
    });
    expect(
      alertText(
        {
          type: "manual_attention",
          product: null,
          details: { reason: "audio_too_long", durationSeconds: 252, maxSeconds: 180 },
        },
        en,
      ),
    ).toEqual({ key: "audioTooLong", params: { length: "4:12", limit: "3" } });
    expect(
      alertText(
        {
          type: "manual_attention",
          product: null,
          details: {
            reason: "audio_too_long",
            durationSeconds: null,
            sizeBytes: 3355443,
            maxSeconds: 180,
          },
        },
        es,
      ),
    ).toEqual({ key: "audioTooLongSize", params: { size: "3,2", limit: "3" } });
    expect(
      alertText(
        { type: "integration_error", product: null, details: { reason: "n8n_delivery_failed" } },
        en,
      ),
    ).toEqual({ key: "n8nDeliveryFailed", params: {} });
    expect(
      alertText(
        {
          type: "integration_error",
          product: null,
          details: {
            reason: "n8n_workflow_error",
            workflow: "Receiver",
            node: null,
            message: "timeout",
          },
        },
        en,
      ),
    ).toEqual({ key: "n8nWorkflowError", params: { where: "Receiver", message: "timeout" } });
    expect(
      alertText({ type: "possible_opt_out", product: null, details: { matched: "no más" } }, en),
    ).toEqual({ key: "possibleOptOut", params: { phrase: "no más" } });
  });

  it("anything incomplete falls back to the stored title (null)", () => {
    expect(alertText({ type: "price_change", product: null, details: {} }, en)).toBeNull();
    expect(alertText({ type: "low_stock", product, details: null }, en)).toBeNull();
    expect(alertText({ type: "missing_data", product, details: { x: 1 } }, en)).toBeNull();
    expect(
      alertText({ type: "manual_attention", product: null, details: { reason: "other" } }, en),
    ).toBeNull();
  });
});

describe("digestItemView", () => {
  it("each category becomes what the screen writes", () => {
    expect(
      digestItemView({
        category: "run_summary",
        runId: "r",
        supplierName: "Norte",
        increases: 3,
        increasesOverThreshold: 1,
        thresholdPct: 10,
        lowStock: 0,
        pendingReviews: 2,
      }),
    ).toEqual({
      kind: "run",
      supplier: "Norte",
      increases: 3,
      over: 1,
      thresholdPct: 10,
      lowStock: 0,
      reviews: 2,
    });
    expect(
      digestItemView({
        category: "order",
        messageId: "m",
        contactName: null,
        preview: "3 macetas",
      }),
    ).toEqual({ kind: "order", name: null, preview: "3 macetas" });
    expect(
      digestItemView({
        category: "customer_query",
        messageId: "m",
        contactName: "Ana",
        preview: "?",
      }),
    ).toEqual({ kind: "query", name: "Ana", preview: "?" });
    expect(digestItemView({ category: "integration_error", source: "n8n", message: "x" })).toEqual({
      kind: "error",
      source: "n8n",
      message: "x",
    });
    expect(
      digestItemView({
        category: "manual_attention",
        title: "t",
        reason: "audio_too_long",
        durationSeconds: 200,
      }),
    ).toEqual({ kind: "audio", seconds: 200, sizeBytes: null, maxSeconds: null });
  });

  it("old or unknown items keep their stored title (null)", () => {
    expect(digestItemView({ category: "manual_attention", title: "Audio viejo" })).toBeNull();
    expect(digestItemView({ category: "something_new" })).toBeNull();
    expect(digestItemView(undefined)).toBeNull();
  });
});

describe("password policy codes", () => {
  it("known codes become issues the panel translates; other details stay as the API wrote them", () => {
    expect(
      userErrorKey(
        new ApiError(400, "VALIDATION_ERROR", "Password does not meet the policy", [
          { code: "too_short", message: "At least 15 characters." },
          { code: "common", message: "It is a known password." },
          { code: "custom", message: "Something else." },
        ]),
      ),
    ).toEqual({ key: "invalid", issues: ["too_short", "common"], details: ["Something else."] });
  });
});
