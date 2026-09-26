/**
 * Numbers typed by a person (es-UY) → a JS number for the API (phase 9 M6). One decimal
 * separator (comma or dot); a dot followed by exactly 3 digits ("1.500") is ambiguous and
 * refused, like prices. No thousands separators.
 */
export type NumberParse = { ok: true; value: number } | { ok: false; message: string };

export function parseNumberInput(
  raw: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): NumberParse {
  const value = raw.trim().replace(/\s/g, "");
  if (value === "") return { ok: false, message: "Escribí un número." };
  if (/^\d+\.\d{3}$/.test(value)) {
    return { ok: false, message: "Escribilo sin punto de miles (por ejemplo 1500)." };
  }
  const match = /^(-?\d{1,9})(?:[.,](\d{1,4}))?$/.exec(value);
  if (!match) return { ok: false, message: "Usá solo números y, si hace falta, una coma decimal." };
  if (options.integer && match[2]) return { ok: false, message: "Tiene que ser un número entero." };
  const n = Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  if (options.min !== undefined && n < options.min)
    return { ok: false, message: `El mínimo es ${String(options.min).replace(".", ",")}.` };
  if (options.max !== undefined && n > options.max)
    return { ok: false, message: `El máximo es ${String(options.max).replace(".", ",")}.` };
  return { ok: true, value: n };
}

/** A number for an editable field: es-UY decimal comma, no thousands dot. */
export function toNumberInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value).replace(".", ",");
}
