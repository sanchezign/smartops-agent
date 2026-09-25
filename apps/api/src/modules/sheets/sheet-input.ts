import type { LlmContent } from "../../ai/llm-provider.js";
import { cellText, type SheetTable } from "../documents/document-types.js";
import { neutralizeTags } from "../extraction/message-input.js";

/**
 * LLM content for the spreadsheet path (pure, phase 5 M3c). Everything from the file is
 * untrusted data inside <sheet_sample> / <product_names> with our tags neutralized (as in
 * M2). The golden key (fakeKeyText) is the file's own content only, never the catalog.
 */

export const SAMPLE_ROWS = 12;
const MAX_CELL = 120;

const clean = (value: string, max: number) =>
  neutralizeTags(value)
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** One table's sample: "R<n> | C<i>: value | …" (empty cells omitted). */
export function sampleTable(table: SheetTable, label: string, rows = SAMPLE_ROWS): string {
  const lines = table.rows.slice(0, rows).map((row, r) => {
    const cells = row
      .map((cell, c) => ({ c, v: clean(cellText(cell), MAX_CELL) }))
      .filter((x) => x.v !== "")
      .map((x) => `C${x.c}: ${x.v}`);
    return `R${r} | ${cells.join(" | ")}`;
  });
  const sheet = clean(table.name, 60).replace(/"/g, "'");
  return `<sheet_sample table="${label}" sheet="${sheet}">\n${lines.join("\n")}\n</sheet_sample>`;
}

/** Mapper input: the tables to map, labelled with their index in the document (T1…). */
export function buildMapperContent(tables: { index: number; table: SheetTable }[]): LlmContent[] {
  const samples = tables
    .map(({ index, table }) => sampleTable(table, `T${index + 1}`))
    .join("\n\n");
  return [
    {
      type: "text",
      text: `${samples}\n\nMap the columns of every table above.`,
      fakeKeyText: samples,
    },
  ];
}

export interface MatcherRow {
  /** "R<n>" (index of the item in the document). */
  id: string;
  name: string;
  unit: string | null;
}

/**
 * Matcher input: catalog first (trusted, cached across the batches of one run), then the
 * untrusted names. The matcher only answers row / ref / confidence.
 */
export function buildMatcherContent(rows: MatcherRow[], catalogText: string): LlmContent[] {
  const names = rows
    .map((r) => `${r.id} | ${clean(r.name, 200)} | ${r.unit ? clean(r.unit, 40) : "-"}`)
    .join("\n");
  return [
    { type: "text", text: `<catalog>\n${catalogText}\n</catalog>`, fakeKeyText: "", cache: true },
    {
      type: "text",
      text: `<product_names>\n${names}\n</product_names>\n\nMatch every R line.`,
      fakeKeyText: names,
    },
  ];
}
