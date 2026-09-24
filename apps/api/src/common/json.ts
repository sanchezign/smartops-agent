import { Prisma } from "../generated/prisma/client.js";

/**
 * JSON replacer registered as Express "json replacer": every Prisma Decimal is
 * serialized as a plain decimal string (never a JS number, never exponent
 * notation), e.g. price 1234.5 → "1234.5".
 *
 * JSON.stringify calls toJSON() before the replacer, so we read the original
 * value from the holder (`this[key]`).
 */
export function decimalJsonReplacer(this: unknown, key: string, value: unknown): unknown {
  const original = (this as Record<string, unknown>)[key];
  if (Prisma.Decimal.isDecimal(original)) {
    return (original as Prisma.Decimal).toFixed();
  }
  return value;
}

/** Same serialization for payloads not sent through res.json (e.g. SSE). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, decimalJsonReplacer);
}
