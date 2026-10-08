/* FROZEN COPY of apps/api/src/modules/sheets/fake-responders.ts as of commit c4d2f42 (phase 14 M5b, BEFORE the heuristics got a language).
 * It is the reference of what the Spanish behavior WAS: test/unit/heuristics-es-identical.test.ts compares
 * today's code, with the language set to "es", against it. Never edit it. */
import type { StructuredRequest } from "../../../../src/ai/llm-provider.js";
import type { FakeResponder } from "../../../../src/ai/providers/fake.js";
import { containsInjection } from "./list-rules.js";
import type {
  MapperOutput,
  MapperTable,
  MatcherOutput,
} from "../../../../src/modules/sheets/sheet-mapping.js";

/**
 * Heuristics for the fake LLM (dev, tests, keyless demo) on the spreadsheet path, used when
 * no golden output exists. Conservative: confidence "medium", matches "low" (a human
 * reviews). Real understanding comes from Claude.
 */

function textOf(request: StructuredRequest<unknown>): string {
  return request.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

type Row = Map<number, string>;

function parseSamples(text: string): { table: string; rows: Row[] }[] {
  return [
    ...text.matchAll(/<sheet_sample table="(T\d+)"[^>]*>\n([\s\S]*?)\n<\/sheet_sample>/g),
  ].map((m) => ({
    table: m[1]!,
    rows: (m[2] ?? "").split("\n").map((line) => {
      const row: Row = new Map();
      for (const cell of line.split(" | ").slice(1)) {
        const match = /^C(\d+): (.*)$/.exec(cell);
        if (match) row.set(Number(match[1]), match[2]!);
      }
      return row;
    }),
  }));
}

const find = (row: Row, re: RegExp) => [...row.entries()].find(([, v]) => re.test(v))?.[0] ?? null;
const isNumber = (v: string) => /^[\d.,$\s]+$/.test(v);

function mapTable(table: string, rows: Row[]): MapperTable {
  const headerRow = Math.max(
    0,
    rows.findIndex((r) => r.size >= 2 && [...r.values()].every((v) => !isNumber(v))),
  );
  const header = rows[headerRow] ?? new Map<number, string>();
  const priceColumns = [...header.entries()]
    .filter(([, v]) =>
      /precio|price|valor|importe|mayorista|contado|tarjeta|efectivo|lista|p\.?\s?u/i.test(v),
    )
    .map(([column, v]) => ({
      column,
      header: v,
      taxIncluded: /c\/\s?iva|con iva|iva incl|final/i.test(v)
        ? true
        : /s\/\s?iva|sin iva|\+\s?iva|neto/i.test(v)
          ? false
          : null,
      kind: /mayor/i.test(v)
        ? ("wholesale" as const)
        : /contado|efectivo/i.test(v)
          ? ("cash" as const)
          : /tarjeta|cr[eé]dito/i.test(v)
            ? ("card" as const)
            : /costo/i.test(v)
              ? ("cost" as const)
              : ("list" as const),
    }));
  const nameColumn =
    find(header, /producto|descrip|art[ií]culo|detalle|nombre|item/i) ??
    [...header.keys()].find((c) => !priceColumns.some((p) => p.column === c)) ??
    null;
  const priceValues = rows
    .slice(headerRow + 1)
    .flatMap((r) => priceColumns.map((p) => r.get(p.column) ?? ""));
  return {
    table,
    isPriceTable: nameColumn !== null && priceColumns.length > 0,
    headerRow,
    nameColumn,
    unitColumn: find(header, /unidad|u\.?\s?m\.?$|presentaci/i),
    skuColumn: find(header, /c[oó]d|sku|ref/i),
    currencyColumn: find(header, /moneda/i),
    stockColumn: find(header, /stock|existencia/i),
    availableColumn: find(header, /disponib/i),
    pctColumn: find(header, /%|aumento|variaci/i),
    priceColumns,
    recommendedPriceColumn:
      (priceColumns.find((p) => p.taxIncluded) ?? priceColumns[0])?.column ?? null,
    priceFormat: priceValues.some((v) => /\d,\d{1,2}$/.test(v)) ? "decimal_comma" : "decimal_dot",
    currency: null,
    confidence: "medium",
  };
}

export const fakeMapColumns: FakeResponder = (request) => {
  const text = textOf(request);
  const out: MapperOutput = {
    tables: parseSamples(text).map((s) => mapTable(s.table, s.rows)),
    supplierName: null,
    warnings: ["Mapeo heurístico del proveedor fake: revisar."],
    suspiciousInstructions: containsInjection(text),
  };
  return out;
};

export const fakeMatch: FakeResponder = (request) => {
  const names = /<product_names>\n([\s\S]*?)\n<\/product_names>/.exec(textOf(request))?.[1] ?? "";
  const out: MatcherOutput = {
    matches: names
      .split("\n")
      .map((line) => /^(R\d+) \|/.exec(line)?.[1])
      .filter((id): id is string => Boolean(id))
      .map((row) => ({ row, ref: null, confidence: "low" as const })),
  };
  return out;
};
