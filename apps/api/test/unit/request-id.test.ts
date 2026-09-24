import { describe, expect, it } from "vitest";
import { resolveRequestId } from "../../src/common/middleware/request-id.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveRequestId", () => {
  it("reuses a safe incoming id", () => {
    expect(resolveRequestId("render-abc_123.4:5")).toBe("render-abc_123.4:5");
  });

  it("uses the first value when the header is repeated", () => {
    expect(resolveRequestId(["first", "second"])).toBe("first");
  });

  it.each([undefined, "", "has space", "line\nbreak", "x".repeat(129), "<script>"])(
    "generates a UUID for %j",
    (incoming) => {
      expect(resolveRequestId(incoming)).toMatch(UUID);
    },
  );
});
