import { describe, expect, it } from "vitest";
import {
  allowedPreviousStatuses,
  canTransition,
  toMessageStatus,
} from "../../src/modules/whatsapp/message-status.js";

describe("toMessageStatus", () => {
  it("maps Meta statuses, played → read, unknown → null", () => {
    expect(toMessageStatus("sent")).toBe("sent");
    expect(toMessageStatus("delivered")).toBe("delivered");
    expect(toMessageStatus("read")).toBe("read");
    expect(toMessageStatus("played")).toBe("read");
    expect(toMessageStatus("failed")).toBe("failed");
    expect(toMessageStatus("deleted")).toBeNull();
  });
});

describe("forward-only transitions", () => {
  it("moves forward", () => {
    expect(canTransition("pending", "sent")).toBe(true);
    expect(canTransition("sent", "delivered")).toBe(true);
    expect(canTransition("sent", "read")).toBe(true);
    expect(canTransition("delivered", "read")).toBe(true);
  });

  it("never moves backwards or sideways (out-of-order / duplicate deliveries)", () => {
    expect(canTransition("read", "delivered")).toBe(false);
    expect(canTransition("delivered", "sent")).toBe(false);
    expect(canTransition("read", "read")).toBe(false);
  });

  it("failed overrides pending/sent/delivered but never read", () => {
    expect(allowedPreviousStatuses("failed")).toEqual(["pending", "sent", "delivered"]);
    expect(canTransition("read", "failed")).toBe(false);
  });

  it("a failed message is not revived by later statuses", () => {
    expect(canTransition("failed", "delivered")).toBe(false);
    expect(canTransition("failed", "read")).toBe(false);
  });

  it("never touches inbound messages", () => {
    for (const next of ["sent", "delivered", "read", "failed"] as const) {
      expect(canTransition("received", next)).toBe(false);
    }
  });
});
