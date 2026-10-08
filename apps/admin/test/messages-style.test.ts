import { describe, expect, it } from "vitest";
import en from "../src/i18n/messages/en.json";
import es from "../src/i18n/messages/es.json";

/**
 * Language rules of the catalogs (phase 13, user decision 2026-09-28):
 * - Spanish is NEUTRAL: "tú" in the panel, never voseo ("vos", "tenés", "revisá", "podés").
 * - English has no Spanish left in it.
 * The voseo check is a heuristic: voseo stresses the last syllable ("revisá", "tenés", "elegí"),
 * so a word ending in a stressed vowel (+ s) fails unless it is a known neutral form. Future tense
 * ("aplicará", "tendrá", "podrás") is allowed, except the voseo imperatives of -rar verbs that
 * look like it ("mirá", "entrá"); add real neutral words to NEUTRAL when needed.
 */

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(strings)
      : [];

const words = (text: string) =>
  text
    // ICU placeholders and tags are not words: {count}, <strong>.
    .replace(/\{[^}]*\}|<[^>]*>/g, " ")
    .toLowerCase()
    .match(/[a-záéíóúüñ]+/g) ?? [];

/** Neutral words that end in a stressed vowel (+ s). */
const NEUTRAL = new Set([
  "está",
  "están",
  "estás",
  "qué",
  "sí",
  "aquí",
  "allí",
  "ahí",
  "más",
  "además",
  "demás",
  "atrás",
  "jamás",
  "después",
  "través",
  "país",
  "interés",
  "inglés",
  "café",
  "también",
  "según",
  "algún",
  "ningún",
  "aún",
  "así",
  "revés",
  "esté",
]);
/** Voseo imperatives of -rar verbs, which look like future tense ("mirá" = look). */
const VOSEO_EXCEPTIONS = new Set(["mirá", "entrá", "borrá", "cerrá", "comprá", "registrá"]);
const VOSEO_WORDS = new Set(["vos", "sos", "tenés", "querés", "podés", "sabés", "hacés"]);

function voseo(text: string): string[] {
  return words(text).filter((w) => {
    if (VOSEO_WORDS.has(w) || VOSEO_EXCEPTIONS.has(w)) return true;
    if (NEUTRAL.has(w)) return false;
    if (/rá[ns]?$/.test(w)) return false; // future: aplicará, tendrá, podrás
    return /[áéí]s?$/.test(w);
  });
}

describe("Spanish catalog is neutral (no voseo)", () => {
  it("the heuristic catches voseo and lets neutral Spanish through", () => {
    expect(voseo("Revisá los datos y escribí un número; si tenés dudas, mirá la guía.")).toEqual([
      "revisá",
      "escribí",
      "tenés",
      "mirá",
    ]);
    expect(
      voseo("Revisa los datos y escribe un número; si tienes dudas, se aplicará igual."),
    ).toEqual([]);
  });

  it("no voseo in any Spanish message", () => {
    const found = strings(es).flatMap((text) => voseo(text).map((w) => `${w}  ←  ${text}`));
    expect(found).toEqual([]);
  });
});

describe("English catalog", () => {
  it("has no Spanish characters or punctuation", () => {
    const found = strings(en).filter((text) => /[áéíóúñ¿¡]/i.test(text));
    expect(found).toEqual([]);
  });
});

describe("tax wording (phase 14)", () => {
  it('the English panel says "tax", never "VAT" (the demo business is American)', () => {
    for (const text of strings(en)) expect(text, text).not.toMatch(/\bVAT\b/);
  });

  it('the Spanish panel keeps "IVA" for the same keys', () => {
    const all = strings(es).join("\n");
    expect(all).toContain("con IVA");
    expect(all).toContain("sin IVA");
    expect(strings(es).some((t) => /\btax\b/i.test(t))).toBe(false);
  });
});
