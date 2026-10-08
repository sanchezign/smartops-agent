import type { BusinessLanguage } from "../../common/business-texts.js";
import { normalizeProductName } from "./normalize.js";

/**
 * Distinguishing attributes of a product name (pure): sizes, measures and capacities
 * such as "6mm", "25kg", "4L", "9W", "1/2 pulgada". Used as a safety net for catalog
 * matching: when the catalog product has an attribute that the extracted line does not
 * state (e.g. line "Arandela" vs catalog "Arandela 6mm"), the match cannot be "high"
 * — a human confirms it. Units are canonicalized ("4 litros" = "4L" = "4 lts" → "4l").
 */

type UnitAliases = ReadonlyArray<readonly [canonical: string, aliases: readonly string[]]>;

/** Spanish unit words: exactly what this module always had. */
const UNIT_ALIASES_ES: UnitAliases = [
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

/** US customary + the metric units a US hardware list also uses (phase 14 M5b, ADR-031). */
const UNIT_ALIASES_EN: UnitAliases = [
  ["mm", ["mm"]],
  ["cm", ["cm"]],
  ["ml", ["ml", "cc"]],
  ["m", ["meters", "meter", "m"]],
  ["kg", ["kgs", "kg", "kilos", "kilo"]],
  ["g", ["grams", "gram", "g"]],
  ["l", ["liters", "liter", "litres", "litre", "l"]],
  ["w", ["watts", "watt", "w"]],
  ["v", ["volts", "volt", "v"]],
  ["a", ["amps", "amp"]],
  ["hp", ["hp"]],
  ["in", ["inches", "inch", "in", '"']],
  ["ft", ["feet", "foot", "ft"]],
  ["lb", ["pounds", "pound", "lbs", "lb"]],
  ["oz", ["ounces", "ounce", "oz"]],
  ["gal", ["gallons", "gallon", "gal"]],
  ["qt", ["quarts", "quart", "qt"]],
  ["awg", ["awg"]],
  ["psi", ["psi"]],
];

function buildTable(aliases: UnitAliases) {
  const canonical = new Map<string, string>(
    aliases.flatMap(([unit, words]) => words.map((w) => [w, unit] as const)),
  );
  // Longest alias first so "mts" wins over "m" and "ml" over "m".
  const alternation = [...canonical.keys()]
    .sort((x, y) => y.length - x.length)
    .map((w) => w.replace(/"/g, '\\"'))
    .join("|");
  return {
    canonical,
    pattern: new RegExp(`(\\d+(?:[./]\\d+)?)\\s*(${alternation})(?![a-z0-9])`, "g"),
  };
}

const TABLES: Record<BusinessLanguage, ReturnType<typeof buildTable>> = {
  es: buildTable(UNIT_ALIASES_ES),
  en: buildTable(UNIT_ALIASES_EN),
};

/** "2.50" → "2.5", "6.0" → "6"; fractions ("1/2") are kept as written. */
function canonicalNumber(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function distinguishingAttributes(
  text: string,
  language: BusinessLanguage = "es",
): Set<string> {
  const { canonical, pattern } = TABLES[language];
  const normalized = normalizeProductName(text);
  const found = new Set<string>();
  for (const match of normalized.matchAll(pattern)) {
    const [, number, unit] = match;
    if (!number || !unit) continue;
    found.add(`${canonicalNumber(number)}${canonical.get(unit) ?? unit}`);
  }
  return found;
}

/** Attributes of the catalog product that the extracted line does not state. */
export function missingAttributes(
  catalogName: string,
  extractedText: string,
  language: BusinessLanguage = "es",
): string[] {
  const stated = distinguishingAttributes(extractedText, language);
  return [...distinguishingAttributes(catalogName, language)].filter((a) => !stated.has(a));
}
