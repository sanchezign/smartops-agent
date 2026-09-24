import { describe, expect, it } from "vitest";
import { toJson } from "../../src/common/json.js";
import { Prisma } from "../../src/generated/prisma/client.js";

describe("Decimal JSON serialization", () => {
  it("serializes Decimal as a plain string", () => {
    expect(toJson({ price: new Prisma.Decimal("1234.5") })).toBe('{"price":"1234.5"}');
  });

  it("never uses exponent notation", () => {
    const json = toJson({
      tiny: new Prisma.Decimal("0.0000001"),
      huge: new Prisma.Decimal("1e22"),
    });
    expect(json).toBe('{"tiny":"0.0000001","huge":"10000000000000000000000"}');
  });

  it("works in nested objects and arrays and leaves other values alone", () => {
    const json = toJson({
      items: [{ price: new Prisma.Decimal("0.0350"), qty: 3, name: "bolt" }],
      total: null,
    });
    expect(JSON.parse(json)).toEqual({
      items: [{ price: "0.035", qty: 3, name: "bolt" }],
      total: null,
    });
  });
});
