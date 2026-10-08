/* FROZEN COPY of apps/api/src/modules/catalog/attributes.ts as of commit c4d2f42 (phase 14 M5b, BEFORE the heuristics got a language).
 * It is the reference of what the Spanish behavior WAS: test/unit/heuristics-es-identical.test.ts compares
 * today's code, with the language set to "es", against it. Never edit it. */
import { normalizeProductName } from "../../../../src/modules/catalog/normalize.js";

/**
 * Distinguishing attributes of a product name (pure): sizes, measures and capacities
 * such as "6mm", "25kg", "4L", "9W", "1/2 pulgada". Used as a safety net for catalog
 * matching: when the catalog product has an attribute that the extracted line does not
 * state (e.g. line "Arandela" vs catalog "Arandela 6mm"), the match cannot be "high"
 * — a human confirms it. Units are canonicalized ("4 litros" = "4L" = "4 lts" → "4l").
 */

const UNIT_ALIASES: ReadonlyArray<readonly [canonical: string, aliases: readonly string[]]> = [
  ["mm", ["mm"]],
  ["cm", ["cm"]],
  ["ml", ["ml", "cc"]],
  ["m", ["mts", "mt", "metros", "metro", "m"]],
  ["kg", ["kgs", "kg", "kilos", "kilo"]],
  ["g", ["grs", "gr", "gramos", "g"]],
  ["l", ["lts", "lt", "litros", "litro", "l"]],
  ["w", ["watts", "w"]],
  ["v", ["volts", "v"]],
  ["a", ["amp"]],
  ["hp", ["hp"]],
  ["in", ["pulgadas", "pulgada", "pulg", '"']],
];

const CANONICAL = new Map<string, string>(
  UNIT_ALIASES.flatMap(([canonical, aliases]) => aliases.map((a) => [a, canonical] as const)),
);

// Longest alias first so "mts" wins over "m" and "ml" over "m".
const ALTERNATION = [...CANONICAL.keys()]
  .sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/"/g, '\\"'))
  .join("|");

const ATTRIBUTE_PATTERN = new RegExp(`(\\d+(?:[./]\\d+)?)\\s*(${ALTERNATION})(?![a-z0-9])`, "g");

/** "2.50" → "2.5", "6.0" → "6"; fractions ("1/2") are kept as written. */
function canonicalNumber(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function distinguishingAttributes(text: string): Set<string> {
  const normalized = normalizeProductName(text);
  const found = new Set<string>();
  for (const match of normalized.matchAll(ATTRIBUTE_PATTERN)) {
    const [, number, unit] = match;
    if (!number || !unit) continue;
    found.add(`${canonicalNumber(number)}${CANONICAL.get(unit) ?? unit}`);
  }
  return found;
}

/** Attributes of the catalog product that the extracted line does not state. */
export function missingAttributes(catalogName: string, extractedText: string): string[] {
  const stated = distinguishingAttributes(extractedText);
  return [...distinguishingAttributes(catalogName)].filter((a) => !stated.has(a));
}
