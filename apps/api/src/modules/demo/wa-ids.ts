import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Id generators that look like Meta's (format only — never real ids).
 */

/** "wamid.HBgL…" style message id. */
export function fakeWamid(): string {
  return `wamid.HBgL${randomBytes(24).toString("base64url")}`;
}

/** Numeric media id (15-16 digits), like the ids in media webhooks. */
export function fakeMediaId(): string {
  return `${randomInt(1, 10)}${Array.from({ length: 15 }, () => randomInt(0, 10)).join("")}`;
}

/**
 * Deterministic business-scoped user id for a simulated phone number, so the same
 * simulated contact always gets the same BSUID ("UY.<20 alphanumerics>").
 */
export function fakeBsuidFor(phone: string, country = "UY"): string {
  const hash = createHash("sha256").update(`sim-bsuid:${phone}`).digest("hex").toUpperCase();
  return `${country}.${hash.slice(0, 20)}`;
}

/** Unix seconds as a string (WhatsApp webhook timestamp format). */
export function waTimestamp(date: Date = new Date()): string {
  return String(Math.floor(date.getTime() / 1000));
}
