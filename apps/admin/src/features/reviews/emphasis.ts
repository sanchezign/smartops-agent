/**
 * Phase 16 M5 (ADR-033 §7): the values of a review question (product names, the line, amounts, a
 * percentage) are set in a heavier weight. next-intl only takes strings, numbers and dates as values,
 * so each emphasized value is replaced by a private-use marker, the message is translated as usual
 * (catalogs unchanged), and the result is split back into plain and emphasized parts. Numbers stay as
 * they are: a plural argument (`{count, plural, …}`) must receive the number. Pure — unit tested.
 */

/** The params that carry what is decided. */
export const EMPHASIZED_PARAMS = ["product", "line", "price", "current", "pct"] as const;

const OPEN = "";
const CLOSE = "";
const MARKER = /(\d+)/g;

export interface Part {
  text: string;
  strong: boolean;
}

export function markParams(params: Record<string, string | number>): {
  marked: Record<string, string | number>;
  values: string[];
} {
  const values: string[] = [];
  const marked: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && (EMPHASIZED_PARAMS as readonly string[]).includes(key)) {
      marked[key] = `${OPEN}${values.length}${CLOSE}`;
      values.push(value);
    } else {
      marked[key] = value;
    }
  }
  return { marked, values };
}

/** Splits a translated text with markers into parts; an empty value leaves no part. */
export function splitMarked(text: string, values: readonly string[]): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), strong: false });
    const value = values[Number(match[1])] ?? "";
    if (value) parts.push({ text: value, strong: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), strong: false });
  return parts;
}
