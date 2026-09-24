import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/i;

/**
 * Verifies Meta's `X-Hub-Signature-256` header: `sha256=<hex HMAC-SHA256 of the RAW
 * request body, keyed with the App Secret>`. Must receive the exact bytes Meta sent
 * (never a re-serialized JSON). Constant-time comparison.
 */
export function isValidWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !SIGNATURE_PATTERN.test(signatureHeader)) return false;

  const received = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase(), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Builds a valid header value (used by tests and local tooling). */
export function signWhatsAppBody(rawBody: Buffer | string, appSecret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Constant-time string comparison for the webhook verify token. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
