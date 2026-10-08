import type { AiCallContext, AiClient } from "../../ai/ai.client.js";
import type { StructuredRequest } from "../../ai/llm-provider.js";
import { promptForLanguage, type LoadedPrompt } from "../../ai/prompts.js";
import type { BusinessLanguage } from "../../common/business-texts.js";
import type { Logger } from "../../common/logger.js";
import { normalizeProductName } from "../catalog/normalize.js";
import { cellText, type SheetTable } from "../documents/document-types.js";
import type { CatalogContext } from "../extraction/catalog-context.js";
import {
  deterministicExtractionSchema,
  type ExtractedItem,
  type ExtractionOutput,
} from "../extraction/extraction.schemas.js";
import { allCellText, containsInjection, listSignals, textOutsideRows } from "./list-rules.js";
import type { SheetFormatRepository } from "./sheet-format.repository.js";
import { buildMapperContent, buildMatcherContent, type MatcherRow } from "./sheet-input.js";
import {
  mapperJsonSchema,
  mapperOutputSchema,
  matcherJsonSchema,
  matcherOutputSchema,
  normalizeMapperTable,
  type MapperOutput,
  type MatcherOutput,
  type SheetMapping,
  type TableProposal,
} from "./sheet-mapping.js";
import { failureRate, MAX_FAILURE_RATE, readTable, type RowFailure } from "./sheet-reader.js";
import { headerFingerprint, parsePrice } from "./sheet-values.js";

/**
 * Spreadsheet path of the extraction (phase 5 M3c, ADR-014):
 *  1. every table whose header fingerprint matches an ACTIVE format of the supplier is read
 *     deterministically ($0);
 *  2. a table without a known format (or whose format now fails > 20 % of the rows: the
 *     format is retired) → ONE mapper call on header + sample rows → the run waits for a
 *     human (review column_mapping). Nothing is extracted from an unapproved mapping;
 *  3. rows whose name is not an exact catalog match → compact matcher calls (row, ref,
 *     confidence only), batched, with the cost of ALL batches checked before the first.
 */

/** AI context without the prompt version: each call uses its own prompt's version. */
export type SheetCallContext = Omit<AiCallContext, "promptVersion">;

export const HEADER_SCAN_ROWS = 10;
export const MATCH_BATCH_ROWS = 150;
const PREVIEW_ROWS = 5;

export interface HeaderCandidate {
  row: number;
  fingerprint: string;
  cells: string[];
}

/** Proposal stored in the column_mapping review item. */
export interface ColumnMappingProposal {
  reason: "new_format" | "format_changed";
  supplierName: string | null;
  suspiciousInstructions: boolean;
  warnings: string[];
  retiredFormatIds: string[];
  tables: (TableProposal & { headerCandidates: HeaderCandidate[] })[];
}

export type SheetExtractionResult =
  | { kind: "mapping_required"; proposal: ColumnMappingProposal }
  | {
      kind: "extracted";
      output: ExtractionOutput;
      formatIds: string[];
      stats: { rows: number; failures: number; matchedByLlm: number; llmCalls: number };
    };

export interface SheetExtractionDeps {
  /** The business language (phase 14 M5b, ADR-031); Spanish when absent. */
  getLanguage?: () => Promise<BusinessLanguage>;
  ai: AiClient;
  formats: SheetFormatRepository;
  prompts: { mapper: LoadedPrompt; matcher: LoadedPrompt };
  models: { mapper: string; matcher: string; cacheSystemPrompts: boolean };
}

export interface SheetExtractionInput {
  runId: string;
  messageId: string;
  contactId: string;
  supplierId: string | null;
  tables: SheetTable[];
  catalog: CatalogContext;
  log: Logger;
}

export function headerCandidates(table: SheetTable): HeaderCandidate[] {
  const out: HeaderCandidate[] = [];
  table.rows.slice(0, HEADER_SCAN_ROWS).forEach((row, index) => {
    const fingerprint = headerFingerprint(row);
    if (fingerprint) out.push({ row: index, fingerprint, cells: row.map(cellText) });
  });
  return out;
}

export function sheetPreview(
  table: SheetTable,
  headerRow: number,
  mapping: TableProposal["mapping"],
) {
  const rows = table.rows
    .slice(headerRow + 1)
    .filter((row) => cellText(row[mapping.nameColumn]).trim() !== "")
    .filter((row) => mapping.priceColumns.some((p) => cellText(row[p.column]).trim() !== ""))
    .slice(0, PREVIEW_ROWS);
  return rows.map((row) => ({
    name: cellText(row[mapping.nameColumn]).trim().slice(0, 200),
    prices: Object.fromEntries(
      mapping.priceColumns.map((p) => [
        p.header || `C${p.column}`,
        parsePrice(row[p.column], mapping.priceFormat),
      ]),
    ),
  }));
}

/**
 * What the deterministic sheet read writes into the extraction warnings, per business language
 * (phase 14 M5b, ADR-031). "es" is exactly what it always said.
 */
export const SHEET_WARNINGS: Record<
  BusinessLanguage,
  { mixedTaxBasis: string; unreadableRows(count: number, names: string[]): string }
> = {
  es: {
    mixedTaxBasis: "Hojas con distinta base de IVA en la columna de precio elegida.",
    unreadableRows: (count, names) =>
      `${count} filas con precio ilegible no se leyeron: ${names.join(", ")}${count > 5 ? "…" : ""}.`,
  },
  en: {
    mixedTaxBasis: "Sheets with a different tax basis in the chosen price column.",
    unreadableRows: (count, names) =>
      `${count} rows with an unreadable price were not read: ${names.join(", ")}${count > 5 ? "…" : ""}.`,
  },
};

export function createSheetExtraction(deps: SheetExtractionDeps) {
  async function mapTables(
    input: SheetExtractionInput,
    indexes: number[],
    ctx: SheetCallContext,
    language: BusinessLanguage,
  ): Promise<MapperOutput> {
    const mapper = promptForLanguage(deps.prompts.mapper, language);
    const request: StructuredRequest<MapperOutput> = {
      task: "map_columns",
      model: deps.models.mapper,
      system: mapper.text,
      cacheSystem: deps.models.cacheSystemPrompts,
      content: buildMapperContent(indexes.map((index) => ({ index, table: input.tables[index]! }))),
      jsonSchema: mapperJsonSchema as unknown as Record<string, unknown>,
      schema: mapperOutputSchema,
      effort: "low",
      maxTokens: 3000,
      language,
    };
    return (
      await deps.ai.generateStructured(request, {
        ...ctx,
        promptVersion: mapper.version,
      })
    ).data;
  }

  async function match(
    items: ExtractedItem[],
    catalog: CatalogContext,
    ctx: SheetCallContext,
    language: BusinessLanguage,
  ): Promise<{ matched: number; calls: number }> {
    if (!catalog.text || catalog.refs.size === 0) return { matched: 0, calls: 0 };
    const pending: MatcherRow[] = [];
    items.forEach((item, i) => {
      if (!catalog.byNormalizedName.has(normalizeProductName(item.name)))
        pending.push({ id: `R${i + 1}`, name: item.name, unit: item.unit });
    });
    if (pending.length === 0) return { matched: 0, calls: 0 };
    const matcherCtx = { ...ctx, promptVersion: deps.prompts.matcher.version };

    const requests: StructuredRequest<MatcherOutput>[] = [];
    for (let i = 0; i < pending.length; i += MATCH_BATCH_ROWS) {
      requests.push({
        task: "match",
        model: deps.models.matcher,
        system: deps.prompts.matcher.text,
        cacheSystem: deps.models.cacheSystemPrompts,
        content: buildMatcherContent(pending.slice(i, i + MATCH_BATCH_ROWS), catalog.text),
        jsonSchema: matcherJsonSchema as unknown as Record<string, unknown>,
        schema: matcherOutputSchema,
        effort: "low",
        maxTokens: 6000,
        language,
      });
    }
    // Every batch must fit the budgets before the first one is sent.
    await deps.ai.preflight(
      {
        task: "match",
        model: deps.models.matcher,
        estimatedUsd: requests.reduce((sum, r) => sum + deps.ai.estimateUsd(r), 0),
        isExtraction: false,
      },
      matcherCtx,
    );

    let matched = 0;
    for (const [b, request] of requests.entries()) {
      const batch = new Set(
        pending.slice(b * MATCH_BATCH_ROWS, (b + 1) * MATCH_BATCH_ROWS).map((r) => r.id),
      );
      const answered = new Set<string>();
      const { data } = await deps.ai.generateStructured(request, matcherCtx);
      for (const m of data.matches) {
        // Only rows of this batch, once; refs are re-validated by applyExtractionRules.
        if (!batch.has(m.row) || answered.has(m.row)) continue;
        answered.add(m.row);
        const item = items[Number(m.row.slice(1)) - 1]!;
        item.catalogRef = m.ref && catalog.refs.has(m.ref) ? m.ref : null;
        item.matchConfidence = item.catalogRef || m.ref === null ? m.confidence : "low";
        if (item.catalogRef) matched += 1;
      }
      for (const id of batch) {
        if (answered.has(id)) continue;
        const item = items[Number(id.slice(1)) - 1]!;
        item.catalogRef = null;
        item.matchConfidence = "low"; // no answer → a human decides
      }
    }
    return { matched, calls: requests.length };
  }

  return {
    async extract(
      input: SheetExtractionInput,
      ctx: SheetCallContext,
    ): Promise<SheetExtractionResult> {
      const language = deps.getLanguage ? await deps.getLanguage() : "es";
      const known = input.supplierId ? await deps.formats.active(input.supplierId) : [];
      const byFingerprint = new Map(known.map((f) => [f.fingerprint, f]));
      const candidates = input.tables.map(headerCandidates);

      const located = candidates.map((list) => {
        for (const c of list) {
          const format = byFingerprint.get(c.fingerprint);
          if (format) return { headerRow: c.row, format };
        }
        return null;
      });

      // Tables with a possible header but no remembered format need a (reviewed) mapping.
      const unknown = new Set<number>();
      candidates.forEach((list, i) => {
        if (!located[i] && list.length > 0) unknown.add(i);
      });

      const retired: string[] = [];
      const reads = new Map<number, ReturnType<typeof readTable>>();
      if (unknown.size === 0) {
        for (const [i, loc] of located.entries()) {
          if (!loc || !loc.format.format.isPriceTable) continue;
          const read = readTable(
            input.tables[i]!,
            loc.headerRow,
            loc.format.format.mapping,
            language,
          );
          if (failureRate(read) > MAX_FAILURE_RATE) {
            await deps.formats.retire(loc.format.id, "validation_failed");
            retired.push(loc.format.id);
            input.log.warn(
              { formatId: loc.format.id, failures: read.failures.length, rows: read.items.length },
              "sheet format failed validation: retired, the table is mapped again",
            );
            located[i] = null;
            unknown.add(i);
          } else {
            reads.set(i, read);
          }
        }
      }

      if (unknown.size > 0) {
        const indexes = [...unknown].sort((a, b) => a - b);
        const mapped = await mapTables(input, indexes, ctx, language);
        const tables: ColumnMappingProposal["tables"] = input.tables.map((table, i) => {
          const loc = located[i];
          const width = Math.max(0, ...table.rows.map((r) => r.length));
          if (loc) {
            const stored = loc.format.format;
            const mapping = stored.isPriceTable
              ? stored.mapping
              : ({ ...emptyMapping(), priceColumn: null } as TableProposal["mapping"]);
            return {
              table: `T${i + 1}`,
              sheet: table.name,
              isPriceTable: stored.isPriceTable,
              headerRow: loc.headerRow,
              fingerprint: loc.format.fingerprint,
              headerCells: table.rows[loc.headerRow]?.map(cellText) ?? [],
              mapping,
              ambiguous: false,
              recommendedPriceColumn: mapping.priceColumn,
              confidence: "high",
              remembered: true,
              preview: stored.isPriceTable ? sheetPreview(table, loc.headerRow, mapping) : [],
              headerCandidates: candidates[i]!,
            };
          }
          const answer = mapped.tables.find((t) => t.table === `T${i + 1}`);
          const headerRow = Math.min(answer?.headerRow ?? 0, Math.max(0, table.rows.length - 1));
          const normalized = answer
            ? normalizeMapperTable({ ...answer, headerRow }, width)
            : {
                mapping: { ...emptyMapping(), priceColumn: null },
                ambiguous: false,
                recommendedPriceColumn: null,
              };
          const isPriceTable = Boolean(answer?.isPriceTable && answer.nameColumn !== null);
          return {
            table: `T${i + 1}`,
            sheet: table.name,
            isPriceTable,
            headerRow,
            fingerprint: headerFingerprint(table.rows[headerRow] ?? []),
            headerCells: table.rows[headerRow]?.map(cellText) ?? [],
            mapping: normalized.mapping,
            ambiguous: normalized.ambiguous,
            recommendedPriceColumn: normalized.recommendedPriceColumn,
            confidence: answer?.confidence ?? "low",
            remembered: false,
            preview: isPriceTable ? sheetPreview(table, headerRow, normalized.mapping) : [],
            headerCandidates: candidates[i]!,
          };
        });
        return {
          kind: "mapping_required",
          proposal: {
            reason: retired.length > 0 ? "format_changed" : "new_format",
            supplierName: mapped.supplierName,
            suspiciousInstructions:
              mapped.suspiciousInstructions || containsInjection(allCellText(input.tables)),
            warnings: mapped.warnings,
            retiredFormatIds: retired,
            tables: tables.filter((t) => t.headerCandidates.length > 0 || t.remembered),
          },
        };
      }

      // ─── Deterministic read with approved formats ───
      const items: ExtractedItem[] = [];
      const failures: RowFailure[] = [];
      const mappings: SheetMapping[] = [];
      const headerRows = new Map<number, number>();
      const formatIds: string[] = [];
      let truncated = false;
      for (const [i, loc] of located.entries()) {
        if (!loc) continue;
        headerRows.set(i, loc.headerRow);
        formatIds.push(loc.format.id);
        const read = reads.get(i);
        if (!read || !loc.format.format.isPriceTable) continue;
        items.push(...read.items);
        failures.push(...read.failures);
        mappings.push(loc.format.format.mapping);
        truncated ||= input.tables[i]!.truncated;
      }
      await deps.formats.markUsed(formatIds);

      const { matched, calls } = await match(items, input.catalog, ctx, language);

      const warnings: string[] = [];
      const signals = listSignals(textOutsideRows(input.tables, headerRows), language);
      const taxValues = [...new Set(mappings.map((m) => m.taxIncluded).filter((v) => v !== null))];
      if (taxValues.length > 1) warnings.push(SHEET_WARNINGS[language].mixedTaxBasis);
      const currencies = [...new Set(mappings.map((m) => m.currency).filter((v) => v !== null))];
      if (failures.length > 0) {
        warnings.push(
          SHEET_WARNINGS[language].unreadableRows(
            failures.length,
            failures.slice(0, 5).map((f) => f.name),
          ),
        );
      }
      const fullList = signals.fullListEvidence !== null && !truncated && failures.length === 0;
      const output = deterministicExtractionSchema.parse({
        isPriceList: items.length > 0,
        listKind: fullList ? "full_list" : "partial_update",
        fullListEvidence: fullList ? signals.fullListEvidence : null,
        supplierName: null,
        currency:
          currencies.length === 1
            ? currencies[0]!
            : currencies.length > 1
              ? null
              : signals.currency,
        validFrom: null,
        taxIncluded:
          taxValues.length === 1
            ? taxValues[0]!
            : taxValues.length > 1
              ? null
              : signals.taxIncluded,
        globalChangePct: null,
        items,
        warnings: warnings.slice(0, 30),
        suspiciousInstructions: signals.suspicious || containsInjection(allCellText(input.tables)),
      } satisfies ExtractionOutput);

      input.log.info(
        {
          runId: input.runId,
          rows: items.length,
          failures: failures.length,
          matchedByLlm: matched,
          llmCalls: calls,
        },
        "spreadsheet read with remembered formats",
      );
      return {
        kind: "extracted",
        output,
        formatIds,
        stats: {
          rows: items.length,
          failures: failures.length,
          matchedByLlm: matched,
          llmCalls: calls,
        },
      };
    },
  };
}

function emptyMapping(): Omit<SheetMapping, "priceColumn"> {
  return {
    nameColumn: 0,
    pctColumn: null,
    unitColumn: null,
    skuColumn: null,
    currencyColumn: null,
    stockColumn: null,
    availableColumn: null,
    priceFormat: "decimal_dot",
    currency: null,
    taxIncluded: null,
    priceColumns: [],
  };
}

export type SheetExtraction = ReturnType<typeof createSheetExtraction>;
