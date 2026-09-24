import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  customerServiceWindow,
  WINDOW_SAFETY_MARGIN_MS,
} from "../../src/modules/whatsapp/customer-service-window.js";

const inbound = new Date("2026-09-24T12:00:00Z");
const at = (ms: number) => new Date(inbound.getTime() + ms);

describe("customerServiceWindow", () => {
  it("is closed when the contact never wrote", () => {
    expect(customerServiceWindow(null, inbound)).toEqual({ open: false, closesAt: null });
  });

  it("is open right after an inbound message", () => {
    expect(customerServiceWindow(inbound, at(1_000)).open).toBe(true);
  });

  it("closes 2 minutes before the 24h mark (safety margin)", () => {
    const closesAt = at(CUSTOMER_SERVICE_WINDOW_MS - WINDOW_SAFETY_MARGIN_MS);
    expect(customerServiceWindow(inbound, new Date(closesAt.getTime() - 1))).toEqual({
      open: true,
      closesAt,
    });
    expect(customerServiceWindow(inbound, closesAt).open).toBe(false);
    expect(customerServiceWindow(inbound, at(CUSTOMER_SERVICE_WINDOW_MS - 60_000)).open).toBe(
      false,
    );
  });

  it("is closed after 24h", () => {
    expect(customerServiceWindow(inbound, at(CUSTOMER_SERVICE_WINDOW_MS + 1)).open).toBe(false);
  });
});
