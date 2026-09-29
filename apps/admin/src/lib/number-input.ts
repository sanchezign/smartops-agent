import type { AppLocale } from "@/i18n/locales";

/**
 * Numbers typed by a person → values for the API (phase 9 M6; per language since phase 13).
 * One decimal separator, comma or dot, and NO thousands separators. The group separator of the
 * panel language followed by exactly 3 digits is ambiguous and refused, never guessed:
 * "1.850" in Spanish (es-UY groups with dots), "1,850" in English (groups with commas).
 *
 * Errors are codes (+ params) of the "inputErrors" messages: the screens translate them.
 */

export type InputErrorCode =
  | "required"
  | "thousands"
  | "format"
  | "integer"
  | "min"
  | "max"
  | "priceRequired"
  | "priceThousands"
  | "priceFormat"
  | "pricePositive"
  | "currencyFormat"
  | "priceNeededForNew"
  | "nameRequired"
  | "pickPriceColumn"
  | "keywordsEmpty"
  | "keywordsTooMany"
  | "keywordTooLong"
  | "phoneInvalid"
  | "phonesTooMany"
  | "hoursFormat"
  | "hoursEqual";

export interface InputError {
  code: InputErrorCode;
  /**
   * Numbers are raw (the screen formats them); strings are shown as they are. A "day" param is
   * a weekday number (0 = Sunday) shown as its name in the panel language.
   */
  params?: Record<string, string | number>;
}

export type NumberParse = { ok: true; value: number } | { ok: false; error: InputError };

/** "1.850" (es) / "1,850" (en): the ambiguous group-separator shape of the panel language. */
export function isAmbiguousThousands(value: string, locale: AppLocale): boolean {
  return (locale === "es" ? /^-?\d+\.\d{3}$/ : /^-?\d+,\d{3}$/).test(value);
}

export function parseNumberInput(
  raw: string,
  locale: AppLocale,
  options: { min?: number; max?: number; integer?: boolean } = {},
): NumberParse {
  const value = raw.trim().replace(/\s/g, "");
  if (value === "") return { ok: false, error: { code: "required" } };
  if (isAmbiguousThousands(value, locale)) return { ok: false, error: { code: "thousands" } };
  const match = /^(-?\d{1,9})(?:[.,](\d{1,4}))?$/.exec(value);
  if (!match) return { ok: false, error: { code: "format" } };
  if (options.integer && match[2]) return { ok: false, error: { code: "integer" } };
  const n = Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  if (options.min !== undefined && n < options.min)
    return { ok: false, error: { code: "min", params: { limit: options.min } } };
  if (options.max !== undefined && n > options.max)
    return { ok: false, error: { code: "max", params: { limit: options.max } } };
  return { ok: true, value: n };
}

/** A number for an editable field in the panel language, without thousands separators. */
export function toNumberInput(value: number | null | undefined, locale: AppLocale): string {
  if (value === null || value === undefined) return "";
  return locale === "es" ? String(value).replace(".", ",") : String(value);
}
