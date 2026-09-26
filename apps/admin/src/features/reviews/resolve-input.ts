import type { ApproveInput, ColumnMappingProposal, LineProposal } from "./types";

/**
 * Pure helpers that turn what the person chose into the approve body (phase 9 M2). The API
 * validates everything again (approveReviewSchema); these only avoid sending what it rejects.
 */

export type Parsed = { ok: true; value: string } | { ok: false; message: string };

/**
 * A price typed by a person → the API's plain decimal ("1850", "12.5"). Accepts one decimal
 * separator (comma or dot, up to 4 decimals). A dot followed by exactly 3 digits ("1.850") is
 * ambiguous in Uruguay (thousands or decimals?) and is never guessed — same rule as the lists.
 */
export function parsePriceInput(raw: string): Parsed {
  const value = raw.replace(/[\s$]/g, "");
  if (value === "") return { ok: false, message: "Escribí un precio." };
  if (/^\d+\.\d{3}$/.test(value)) {
    return {
      ok: false,
      message: "¿1.850 es mil ochocientos cincuenta? Escribilo sin punto de miles: 1850 o 1850,50.",
    };
  }
  const match = /^(\d{1,14})(?:[.,](\d{1,4}))?$/.exec(value);
  if (!match) return { ok: false, message: "Usá solo números y una coma para los decimales." };
  const plain = match[2] ? `${match[1]}.${match[2]}` : match[1]!;
  if (Number(plain) <= 0) return { ok: false, message: "El precio tiene que ser mayor que 0." };
  return { ok: true, value: plain.replace(/^0+(?=\d)/, "") };
}

export function parseCurrencyInput(raw: string): Parsed {
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value)
    ? { ok: true, value }
    : { ok: false, message: "La moneda son 3 letras, por ejemplo UYU o USD." };
}

/** Initial choices for a line review: the linked product, else the first candidate, else new. */
export function lineDefaults(
  proposal: LineProposal,
  productId: string | null,
  productCurrency: string | null,
) {
  const target = productId ?? proposal.candidates[0]?.id ?? "new";
  return {
    target,
    price: proposal.proposedPrice ?? proposal.item.price ?? "",
    currency:
      proposal.currency ?? proposal.item.currency ?? proposal.listCurrency ?? productCurrency ?? "",
    name: proposal.item.name,
    unit: proposal.item.unit ?? "",
  };
}

export interface LineChoice {
  target: string; // product id or "new"
  price: string;
  currency: string;
  name: string;
  unit: string;
}

/**
 * Approve body for a line. Values equal to the proposal are NOT sent, so the API applies its
 * own rule (e.g. a percentage applied to the chosen product's current price).
 */
export function lineApproveBody(
  choice: LineChoice,
  defaults: LineChoice,
): { ok: true; body: ApproveInput } | { ok: false; message: string } {
  const body: ApproveInput = {};
  const isNew = choice.target === "new";
  if (isNew) body.createNew = true;
  else body.productId = choice.target;

  const priceEdited = choice.price.trim() !== defaults.price.trim();
  if (priceEdited || (isNew && choice.price.trim() !== "")) {
    const price = parsePriceInput(choice.price);
    if (!price.ok) return price;
    body.price = price.value;
  } else if (isNew && choice.price.trim() === "") {
    return { ok: false, message: "Para crear el producto hace falta el precio." };
  }
  if (choice.currency.trim() !== defaults.currency.trim() || (isNew && choice.currency.trim())) {
    const currency = parseCurrencyInput(choice.currency);
    if (!currency.ok) return currency;
    body.currency = currency.value;
  }
  if (isNew) {
    const name = choice.name.trim();
    if (!name) return { ok: false, message: "Escribí el nombre del producto." };
    if (name !== defaults.name.trim()) body.name = name;
    const unit = choice.unit.trim();
    if (unit && unit !== defaults.unit.trim()) body.unit = unit;
  }
  return { ok: true, body };
}

/** Pre-selected price column per table: the reviewer's pick, else the mapping, else the recommendation. */
export function initialPriceColumns(
  proposal: ColumnMappingProposal,
): Record<string, number | null> {
  return Object.fromEntries(
    proposal.tables
      .filter((t) => !t.remembered && t.isPriceTable)
      .map((t) => [t.table, t.mapping.priceColumn ?? t.recommendedPriceColumn]),
  );
}

export function columnMappingApproveBody(
  proposal: ColumnMappingProposal,
  chosen: Record<string, number | null>,
): { ok: true; body: ApproveInput } | { ok: false; message: string } {
  const tables: NonNullable<ApproveInput["tables"]> = [];
  for (const table of proposal.tables) {
    if (table.remembered || !table.isPriceTable) continue;
    const column = chosen[table.table] ?? null;
    if (column === null) {
      if (table.mapping.pctColumn !== null) continue; // a percentage-only table needs no price
      return { ok: false, message: `Elegí la columna de precio de la hoja "${table.sheet}".` };
    }
    tables.push({ table: table.table, priceColumn: column });
  }
  return { ok: true, body: { tables } };
}
