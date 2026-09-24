import { describe, expect, it } from "vitest";
import {
  isValidWhatsAppSignature,
  safeEqual,
  signWhatsAppBody,
} from "../../src/modules/whatsapp/whatsapp-signature.js";

const SECRET = "test-app-secret-0123456789abcdef";
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe("isValidWhatsAppSignature", () => {
  it("accepts the HMAC-SHA256 of the raw body", () => {
    expect(isValidWhatsAppSignature(body, signWhatsAppBody(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts an uppercase hex digest", () => {
    const header = signWhatsAppBody(body, SECRET).replace(/[0-9a-f]{64}$/, (h) => h.toUpperCase());
    expect(isValidWhatsAppSignature(body, header, SECRET)).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(isValidWhatsAppSignature(body, signWhatsAppBody(body, "other-secret"), SECRET)).toBe(
      false,
    );
  });

  it("rejects when the body was re-serialized (even whitespace changes)", () => {
    const header = signWhatsAppBody(body, SECRET);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(isValidWhatsAppSignature(reserialized, header, SECRET)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["without prefix", signWhatsAppBody(body, SECRET).slice("sha256=".length)],
    ["sha1 prefix", signWhatsAppBody(body, SECRET).replace("sha256=", "sha1=")],
    ["truncated", signWhatsAppBody(body, SECRET).slice(0, -2)],
    ["non-hex", `sha256=${"z".repeat(64)}`],
  ])("rejects a %s header", (_label, header) => {
    expect(isValidWhatsAppSignature(body, header, SECRET)).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares strings of any length without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
