import { describe, expect, it } from "vitest";
import { maskPhone, maskPhonesInText } from "../../src/common/phone.js";

describe("maskPhone", () => {
  it("keeps the first 3 and last 3 digits", () => {
    expect(maskPhone("59899009160")).toBe("598*****160");
  });

  it("drops non-digits before masking", () => {
    expect(maskPhone("+598 99 009 160")).toBe("598*****160");
  });

  it("fully masks short values and handles empty input", () => {
    expect(maskPhone("12345")).toBe("*****");
    expect(maskPhone("")).toBe("");
    expect(maskPhone(undefined)).toBe("");
  });
});

describe("maskPhonesInText", () => {
  it("masks long digit runs inside free text", () => {
    expect(maskPhonesInText("Number +59899009160 is not allowed")).toBe(
      "Number 598*****160 is not allowed",
    );
  });

  it("leaves short numbers (error codes, amounts) untouched", () => {
    expect(maskPhonesInText("Error 131030 after 24 hours")).toBe("Error 131030 after 24 hours");
  });
});
