import type { AppLocale } from "@/i18n/locales";
import { createFormat } from "@/lib/format";
import { isAmbiguousThousands, type InputError } from "@/lib/number-input";
import type { ApproveInput, ColumnMappingProposal, LineProposal } from "./types";

/**
 * Pure helpers that turn what the person chose into the approve body (phase 9 M2). The API
 * validates everything again (approveReviewSchema); these only avoid sending what it rejects.
 * Errors are codes of the "inputErrors" messages (phase 13).
 */

export type Parsed = { ok: true; value: string } | { ok: false; error: InputError };

/**
 * A price typed by a person → the API's plain decimal ("1850", "12.5"). Accepts one decimal
 * separator (comma or dot, up to 4 decimals). The panel language's group separator followed by
 * exactly 3 digits ("1.850" in Spanish, "1,850" in English) is ambiguous (thousands or
 * decimals?) and is never guessed — same rule as the lists.
 */
export function parsePriceInput(raw: string, locale: AppLocale): Parsed {
  const value = raw.replace(/[\s$]/g, "");
  if (value === "") return { ok: false, error: { code: "priceRequired" } };
  if (isAmbiguousThousands(value, locale)) return { ok: false, error: { code: "priceThousands" } };
  const match = /^(\d{1,14})(?:[.,](\d{1,4}))?$/.exec(value);
  if (!match) return { ok: false, error: { code: "priceFormat" } };
  const plain = match[2] ? `${match[1]}.${match[2]}` : match[1]!;
  if (Number(plain) <= 0) return { ok: false, error: { code: "pricePositive" } };
  return { ok: true, value: plain.replace(/^0+(?=\d)/, "") };
}

export function parseCurrencyInput(raw: string): Parsed {
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value)
    ? { ok: true, value }
    : { ok: false, error: { code: "currencyFormat" } };
}

/** Initial choices for a line review: the linked product, else the first candidate, else new. */
export function lineDefaults(
  proposal: LineProposal,
  productId: string | null,
  productCurrency: string | null,
  locale: AppLocale,
) {
  const { toDecimalInput } = createFormat(locale);
  const target = productId ?? proposal.candidates[0]?.id ?? "new";
  return {
    target,
    price: toDecimalInput(proposal.proposedPrice ?? proposal.item.price),
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
  locale: AppLocale,
): { ok: true; body: ApproveInput } | { ok: false; error: InputError } {
  const body: ApproveInput = {};
  const isNew = choice.target === "new";
  if (isNew) body.createNew = true;
  else body.productId = choice.target;

  const priceEdited = choice.price.trim() !== defaults.price.trim();
  if (priceEdited || (isNew && choice.price.trim() !== "")) {
    const price = parsePriceInput(choice.price, locale);
    if (!price.ok) return price;
    body.price = price.value;
  } else if (isNew && choice.price.trim() === "") {
    return { ok: false, error: { code: "priceNeededForNew" } };
  }
  if (choice.currency.trim() !== defaults.currency.trim() || (isNew && choice.currency.trim())) {
    const currency = parseCurrencyInput(choice.currency);
    if (!currency.ok) return currency;
    body.currency = currency.value;
  }
  if (isNew) {
    const name = choice.name.trim();
    if (!name) return { ok: false, error: { code: "nameRequired" } };
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
): { ok: true; body: ApproveInput } | { ok: false; error: InputError } {
  const tables: NonNullable<ApproveInput["tables"]> = [];
  for (const table of proposal.tables) {
    if (table.remembered || !table.isPriceTable) continue;
    const column = chosen[table.table] ?? null;
    if (column === null) {
      if (table.mapping.pctColumn !== null) continue; // a percentage-only table needs no price
      return { ok: false, error: { code: "pickPriceColumn", params: { sheet: table.sheet } } };
    }
    tables.push({ table: table.table, priceColumn: column });
  }
  return { ok: true, body: { tables } };
}
