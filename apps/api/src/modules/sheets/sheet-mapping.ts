import { z } from "zod";
import { MATCH_CONFIDENCES } from "../extraction/extraction.schemas.js";

/**
 * Spreadsheet column mapping (phase 5 M3c, ADR-014). The LLM only looks at the header and
 * ~10 sample rows of each table and says which column is what; the code then reads every
 * row deterministically. A human approves every NEW mapping (review column_mapping) and it
 * is remembered per (supplier, header fingerprint): the next list with the same format
 * costs $0.
 */

export const PRICE_KINDS = ["list", "wholesale", "cash", "card", "cost", "other"] as const;
export const PRICE_FORMATS = ["decimal_comma", "decimal_dot"] as const;
export type PriceFormat = (typeof PRICE_FORMATS)[number];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const nullableInt = nullable({ type: "integer" });

// ─── Mapper (LLM) output ─────────────────────────────────────────────────────

export const mapperJsonSchema = {
  type: "object",
  properties: {
    tables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          table: { type: "string" },
          isPriceTable: { type: "boolean" },
          headerRow: { type: "integer" },
          nameColumn: nullableInt,
          unitColumn: nullableInt,
          skuColumn: nullableInt,
          currencyColumn: nullableInt,
          stockColumn: nullableInt,
          availableColumn: nullableInt,
          pctColumn: nullableInt,
          priceColumns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "integer" },
                header: { type: "string" },
                taxIncluded: nullable({ type: "boolean" }),
                kind: { type: "string", enum: [...PRICE_KINDS] },
              },
              required: ["column", "header", "taxIncluded", "kind"],
              additionalProperties: false,
            },
          },
          recommendedPriceColumn: nullableInt,
          priceFormat: { type: "string", enum: [...PRICE_FORMATS] },
          currency: nullable({ type: "string" }),
          confidence: { type: "string", enum: [...MATCH_CONFIDENCES] },
        },
        required: [
          "table",
          "isPriceTable",
          "headerRow",
          "nameColumn",
          "unitColumn",
          "skuColumn",
          "currencyColumn",
          "stockColumn",
          "availableColumn",
          "pctColumn",
          "priceColumns",
          "recommendedPriceColumn",
          "priceFormat",
          "currency",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    supplierName: nullable({ type: "string" }),
    warnings: { type: "array", items: { type: "string" } },
    suspiciousInstructions: { type: "boolean" },
  },
  required: ["tables", "supplierName", "warnings", "suspiciousInstructions"],
  additionalProperties: false,
} as const;

const column = z.number().int().min(0).max(499);
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

export const priceColumnSchema = z.object({
  column,
  header: z.string().trim().max(200),
  taxIncluded: z.boolean().nullable(),
  kind: z.enum(PRICE_KINDS),
});
export type PriceColumnCandidate = z.infer<typeof priceColumnSchema>;

export const mapperTableSchema = z.object({
  table: z.string().regex(/^T\d{1,3}$/),
  isPriceTable: z.boolean(),
  headerRow: z.number().int().min(0).max(20),
  nameColumn: column.nullable(),
  unitColumn: column.nullable(),
  skuColumn: column.nullable(),
  currencyColumn: column.nullable(),
  stockColumn: column.nullable(),
  availableColumn: column.nullable(),
  pctColumn: column.nullable(),
  priceColumns: z.array(priceColumnSchema).max(20),
  recommendedPriceColumn: column.nullable(),
  priceFormat: z.enum(PRICE_FORMATS),
  currency: currencyCode.nullable(),
  confidence: z.enum(MATCH_CONFIDENCES),
});

export const mapperOutputSchema = z.object({
  tables: z.array(mapperTableSchema).max(20),
  supplierName: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((v) => (v ? v : null)),
  warnings: z.array(z.string().trim().max(300)).max(30),
  suspiciousInstructions: z.boolean(),
});
export type MapperOutput = z.infer<typeof mapperOutputSchema>;
export type MapperTable = z.infer<typeof mapperTableSchema>;

// ─── Approved mapping (memory) ───────────────────────────────────────────────

/** What the deterministic reader needs for one table. Stored per (supplier, fingerprint). */
export const sheetMappingSchema = z
  .object({
    nameColumn: column,
    priceColumn: column.nullable(),
    pctColumn: column.nullable(),
    unitColumn: column.nullable(),
    skuColumn: column.nullable(),
    currencyColumn: column.nullable(),
    stockColumn: column.nullable(),
    availableColumn: column.nullable(),
    priceFormat: z.enum(PRICE_FORMATS),
    currency: currencyCode.nullable(),
    /** From the chosen price column ("Precio c/IVA" → true, "s/IVA" → false). */
    taxIncluded: z.boolean().nullable(),
    /** Every price column found (shown to the reviewer when there is more than one). */
    priceColumns: z.array(priceColumnSchema).max(20),
  })
  .refine((m) => m.priceColumn !== null || m.pctColumn !== null, {
    message: "a price or percentage column is required",
    path: ["priceColumn"],
  });
export type SheetMapping = z.infer<typeof sheetMappingSchema>;

/** A table's proposal in the column_mapping review. */
export interface TableProposal {
  /** "T1"…: index of the table in the converted document. */
  table: string;
  sheet: string;
  isPriceTable: boolean;
  headerRow: number;
  fingerprint: string | null;
  headerCells: string[];
  /** Null while ambiguous (several price columns): the human chooses. */
  mapping: Omit<SheetMapping, "priceColumn"> & { priceColumn: number | null };
  ambiguous: boolean;
  recommendedPriceColumn: number | null;
  confidence: (typeof MATCH_CONFIDENCES)[number];
  /** Already approved format for this supplier (not re-reviewed). */
  remembered: boolean;
  /** First rows read with the proposed mapping (per price column when ambiguous). */
  preview: { name: string; prices: Record<string, string | null> }[];
}

/**
 * Code rules on the mapper output (pure): columns inside the table, the price column is
 * chosen by the code only when there is exactly ONE candidate — several candidates make the
 * mapping ambiguous and a human chooses (the model's recommendation only pre-selects).
 */
export function normalizeMapperTable(
  table: MapperTable,
  width: number,
): {
  mapping: TableProposal["mapping"];
  ambiguous: boolean;
  recommendedPriceColumn: number | null;
} {
  const inside = (c: number | null) => (c !== null && c < width ? c : null);
  const priceColumns = table.priceColumns.filter(
    (p, i, all) => p.column < width && all.findIndex((q) => q.column === p.column) === i,
  );
  const ambiguous = priceColumns.length > 1;
  const chosen = priceColumns.length === 1 ? priceColumns[0]! : null;
  return {
    ambiguous,
    recommendedPriceColumn: inside(table.recommendedPriceColumn),
    mapping: {
      nameColumn: inside(table.nameColumn) ?? 0,
      priceColumn: chosen?.column ?? null,
      pctColumn: inside(table.pctColumn),
      unitColumn: inside(table.unitColumn),
      skuColumn: inside(table.skuColumn),
      currencyColumn: inside(table.currencyColumn),
      stockColumn: inside(table.stockColumn),
      availableColumn: inside(table.availableColumn),
      priceFormat: table.priceFormat,
      currency: table.currency,
      taxIncluded: chosen?.taxIncluded ?? null,
      priceColumns,
    },
  };
}

/** Applies the reviewer's choice of price column (taxIncluded follows the column). */
export function choosePriceColumn(
  mapping: TableProposal["mapping"],
  priceColumn: number,
): SheetMapping {
  const candidate = mapping.priceColumns.find((p) => p.column === priceColumn);
  return sheetMappingSchema.parse({
    ...mapping,
    priceColumn,
    taxIncluded: candidate ? candidate.taxIncluded : mapping.taxIncluded,
  });
}

// ─── Matcher (LLM) output ────────────────────────────────────────────────────

export const matcherJsonSchema = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row: { type: "string" },
          ref: nullable({ type: "string" }),
          confidence: { type: "string", enum: [...MATCH_CONFIDENCES] },
        },
        required: ["row", "ref", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
} as const;

export const matcherOutputSchema = z.object({
  matches: z
    .array(
      z.object({
        row: z.string().regex(/^R\d{1,5}$/),
        ref: z
          .string()
          .regex(/^P\d{1,4}$/)
          .nullable(),
        confidence: z.enum(MATCH_CONFIDENCES),
      }),
    )
    .max(1000),
});
export type MatcherOutput = z.infer<typeof matcherOutputSchema>;
