import { BudgetExceededError, type AiClient } from "../../ai/ai.client.js";
import { LlmError } from "../../ai/llm-provider.js";
import { promptForLanguage, type LoadedPrompt } from "../../ai/prompts.js";
import type { BusinessLanguage } from "../../common/business-texts.js";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { IngestionClassification } from "../../generated/prisma/enums.js";
import type { MediaStorage } from "../media/media-storage.js";
import { documentFormat } from "../documents/document-types.js";
import { buildCatalogContext } from "./catalog-context.js";
import type { SheetExtraction } from "../sheets/sheet-extraction.js";
import { applyDocumentRules } from "./document-rules.js";
import { prefilter } from "./prefilter.js";
import {
  applyExtractionRules,
  classificationJsonSchema,
  classificationSchema,
  extractionJsonSchema,
  extractionSchema,
  type ExtractionOutput,
} from "./extraction.schemas.js";
import type {
  IngestionRepository,
  IngestionRunRecord,
  MessageContext,
  RunDetail,
} from "./ingestion.repository.js";
import {
  buildClassificationContent,
  buildExtractionContent,
  type MessageForAi,
} from "./message-input.js";

/**
 * Classification and extraction of inbound supplier messages (phase 5).
 * - classify(messageId): creates (or reuses) the ingestion run. Text / voice messages
 *   are classified by the LLM; media messages are decided by the extraction itself.
 * - extract(runId): locked per run (classified → extracting, atomic). A concurrent
 *   request never calls the LLM twice: it gets the stored result or IN_PROGRESS.
 * Budget refusal and invalid outputs end in needs_review (a human looks at it);
 * transient provider errors release the lock and surface as retryable.
 */

export interface AiModels {
  classifier: string;
  extractor: string;
  cacheSystemPrompts: boolean;
}

export interface RunResult {
  runId: string;
  status: string;
  classification: IngestionClassification | null;
  reason?: string;
  /** Classified by the deterministic pre-filter (no LLM call). */
  prefilterRule?: string;
  itemCount?: number;
  listKind?: string;
  suspiciousInstructions?: boolean;
  warnings?: string[];
}

/** What extraction stores in ingestion_runs.raw_extraction (input of the catalog ingest). */
export interface StoredExtraction {
  output: ExtractionOutput;
  /** catalogRef → product id, as sent in the <catalog> block. */
  refs: Record<string, string>;
  /** normalized name → product id (exact matches). */
  byNormalizedName: Record<string, string>;
  catalogTruncated: boolean;
  promptVersion: string;
  /** Converted document with possibly missing values (formula without value): every
   *  line goes to review in the catalog ingest (phase 5 M3a). */
  documentIncomplete?: boolean;
  /** Remembered spreadsheet formats used (deterministic path, M3c). */
  sheetFormatIds?: string[];
}

/** GET /api/v1/internal/runs/:id */
export interface RunView {
  runId: string;
  messageId: string;
  status: string;
  classification: IngestionClassification | null;
  supplierId: string | null;
  prefilterRule: string | null;
  itemCount: number | null;
  listKind: string | null;
  suspiciousInstructions: boolean | null;
  errors: unknown;
  ingest: { counts: unknown; pendingReviews: number; gate: unknown } | null;
  reviewItems: { id: string; scope: string; kind: string; status: string }[];
  document: RunDetail["document"];
  costUsd: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface IngestionService {
  classify(messageId: string, log: Logger): Promise<RunResult>;
  extract(runId: string, log: Logger): Promise<RunResult>;
  getRun(runId: string): Promise<RunView>;
}

/** Converted documents with more product lines than this need chunked extraction (M3b). */
export const MAX_SINGLE_CALL_ROWS = 30;

const TABULAR_FORMATS = new Set(["xlsx", "xls", "csv"]);

const PRICE_CLASSES = new Set<IngestionClassification>(["price_list_full", "price_update_partial"]);
const MEDIA_TYPES = new Set(["image", "document"]);

function summary(run: IngestionRunRecord): RunResult {
  const stored = run.rawExtraction as StoredExtraction | null;
  const report = run.report as { reason?: string } | null;
  return {
    runId: run.id,
    status: run.status,
    classification: run.classification,
    ...(report?.reason ? { reason: report.reason } : {}),
    ...(run.prefilterRule ? { prefilterRule: run.prefilterRule } : {}),
    ...(stored?.output
      ? {
          itemCount: stored.output.items.length,
          listKind: stored.output.listKind,
          suspiciousInstructions: stored.output.suspiciousInstructions,
          warnings: stored.output.warnings,
        }
      : {}),
  };
}

export function createIngestionService(deps: {
  repository: IngestionRepository;
  storage: MediaStorage;
  ai: AiClient;
  prompts: { classifier: LoadedPrompt; extractor: LoadedPrompt };
  models: AiModels;
  /** Converted documents above this many product lines go to review (M3b pending). */
  maxSingleCallRows?: number;
  /** Spreadsheet path (M3c): remembered formats + deterministic read + compact matching. */
  sheets?: SheetExtraction;
  /**
   * The business language (`business.language`, phase 14 M5b / ADR-031): the pre-filter words,
   * the texts of the rules, the prompt block and the fake provider follow it. Spanish when absent.
   */
  getLanguage?: () => Promise<BusinessLanguage>;
}): IngestionService {
  const getLanguage = deps.getLanguage ?? (async () => "es" as const);
  const maxSingleCallRows = deps.maxSingleCallRows ?? MAX_SINGLE_CALL_ROWS;
  async function messageForAi(ctx: MessageContext, withMedia: boolean): Promise<MessageForAi> {
    const needsBytes = withMedia && ctx.media?.status === "stored";
    return {
      messageType: ctx.messageType,
      text: ctx.text,
      transcript: ctx.transcript,
      filename: ctx.media?.filename ?? null,
      mimeType: ctx.media?.mimeType ?? null,
      media: needsBytes && ctx.media ? await deps.storage.get(ctx.media.id) : null,
      documentText:
        ctx.media?.conversion?.status === "done" ? (ctx.media.conversion.text ?? null) : null,
      contactKind: ctx.contact.kind,
      supplierName: ctx.supplier?.name ?? null,
    };
  }

  /** Waiting states only (download, transcription, conversion still running). */
  function assertNotPending(ctx: MessageContext): void {
    if (ctx.direction !== "inbound")
      throw errors.badRequest("Only inbound messages can be ingested");
    if (!ctx.media) return;
    if (ctx.media.status === "pending") throw errors.notReady("Media is still being downloaded");
    if (ctx.media.status !== "stored") return; // the pre-filter handles unavailable media
    if (ctx.messageType === "audio" && (ctx.media.transcriptionStatus ?? "pending") === "pending") {
      throw errors.notReady("Voice note is still being transcribed");
    }
    if (
      documentFormat(ctx.media.mimeType, ctx.media.filename) !== null &&
      ctx.media.conversion?.status === "pending"
    ) {
      throw errors.notReady("Document is still being converted");
    }
  }

  function assertReady(ctx: MessageContext): void {
    if (ctx.direction !== "inbound")
      throw errors.badRequest("Only inbound messages can be ingested");
    if (!ctx.media) return;
    if (ctx.media.status === "pending") throw errors.notReady("Media is still being downloaded");
    if (ctx.media.status !== "stored") {
      throw errors.conflict(`Media is ${ctx.media.status}: nothing to extract`, {
        mediaStatus: ctx.media.status,
      });
    }
    if (ctx.messageType === "audio" && (ctx.media.transcriptionStatus ?? "pending") === "pending") {
      throw errors.notReady("Voice note is still being transcribed");
    }
    if (documentFormat(ctx.media.mimeType, ctx.media.filename) !== null) {
      if (!ctx.media.conversion)
        throw errors.conflict("Document has no conversion (stored before phase 5 M3a)");
      if (ctx.media.conversion.status === "pending")
        throw errors.notReady("Document is still being converted");
    }
  }

  return {
    async classify(messageId, log) {
      const ctx = await deps.repository.getMessageContext(messageId);
      if (!ctx) throw errors.notFound("Message not found");
      const language = await getLanguage();
      const classifier = promptForLanguage(deps.prompts.classifier, language);
      const existing = await deps.repository.findActiveRun(messageId);
      if (existing && existing.status !== "pending") return summary(existing);
      assertNotPending(ctx);

      const run = existing ?? (await deps.repository.createRun(messageId, ctx.contact.supplierId));

      // Deterministic pre-filter (phase 6): obvious messages never reach the LLM.
      const decision = prefilter(
        {
          messageType: ctx.messageType,
          contactKind: ctx.contact.kind,
          text: ctx.text,
          transcript: ctx.transcript,
          mediaStatus: ctx.media?.status ?? null,
          transcriptionStatus: ctx.media?.transcriptionStatus ?? null,
          transcriptionReason: ctx.media?.transcriptionReason ?? null,
        },
        language,
      );
      if (decision) {
        await deps.repository.saveClassification(run.id, {
          status: "classified",
          classification: decision.classification,
          report: { reason: decision.reason, prefilter: decision.rule },
          prefilterRule: decision.rule,
        });
        log.info({ runId: run.id, rule: decision.rule }, "message pre-filtered (no LLM)");
        return summary((await deps.repository.getRun(run.id)) ?? run);
      }
      assertReady(ctx);

      if (MEDIA_TYPES.has(ctx.messageType)) {
        await deps.repository.saveClassification(run.id, {
          status: "classified",
          classification: null,
          report: { reason: "media: the extraction decides whether it is a price list" },
        });
        return summary((await deps.repository.getRun(run.id)) ?? run);
      }

      const content = buildClassificationContent(await messageForAi(ctx, false));
      if (!content.ok) {
        await deps.repository.saveClassification(run.id, {
          status: "classified",
          classification: "other",
          report: { reason: `no classifiable content (${content.reason})` },
        });
        return summary((await deps.repository.getRun(run.id)) ?? run);
      }

      try {
        const result = await deps.ai.generateStructured(
          {
            task: "classify",
            model: deps.models.classifier,
            system: classifier.text,
            cacheSystem: deps.models.cacheSystemPrompts,
            content: content.content,
            jsonSchema: classificationJsonSchema as unknown as Record<string, unknown>,
            schema: classificationSchema,
            effort: "low",
            maxTokens: 1024,
            language,
          },
          {
            promptVersion: classifier.version,
            ingestionRunId: run.id,
            messageId,
            contactId: ctx.contact.id,
            log,
          },
        );
        await deps.repository.saveClassification(run.id, {
          status: "classified",
          classification: result.data.classification,
          report: { reason: result.data.reason, confidence: result.data.confidence },
        });
      } catch (err) {
        await handleAiFailure(err, run.id, "classify", log);
      } finally {
        await deps.repository.refreshUsageTotals(run.id);
      }
      return summary((await deps.repository.getRun(run.id)) ?? run);
    },

    async extract(runId, log) {
      const run = await deps.repository.getRun(runId);
      if (!run) throw errors.notFound("Ingestion run not found");
      if (run.status === "extracting")
        throw errors.inProgress("Extraction already running for this run");
      if (run.status === "pending") throw errors.notReady("Classify the message first");
      if (run.status !== "classified") return summary(run); // idempotent: already done
      if (run.prefilterRule) {
        throw errors.conflict(`Message pre-filtered (${run.prefilterRule}): nothing to extract`, {
          prefilterRule: run.prefilterRule,
        });
      }

      if (run.classification && !PRICE_CLASSES.has(run.classification)) {
        throw errors.conflict(`Message classified as ${run.classification}: nothing to extract`);
      }

      const ctx = await deps.repository.getMessageContext(run.messageId);
      const language = await getLanguage();
      const extractor = promptForLanguage(deps.prompts.extractor, language);
      if (!ctx) throw errors.notFound("Message not found");
      if (ctx.contact.kind === "customer") {
        throw errors.conflict("Customer messages never go to price extraction");
      }
      assertReady(ctx);

      if (!(await deps.repository.claimForExtraction(run.id))) {
        const current = await deps.repository.getRun(run.id);
        if (current?.status === "extracting")
          throw errors.inProgress("Extraction already running for this run");
        if (current) return summary(current);
        throw errors.notFound("Ingestion run not found");
      }

      try {
        const catalog = buildCatalogContext(
          ctx.contact.supplierId
            ? await deps.repository.getSupplierCatalog(ctx.contact.supplierId)
            : [],
        );
        // Converted documents: failed conversion or too many lines → human review, no LLM.
        const conversion = ctx.media?.conversion ?? null;
        const tables =
          deps.sheets &&
          conversion?.status === "done" &&
          conversion.tables &&
          conversion.tables.length > 0 &&
          TABULAR_FORMATS.has(conversion.format ?? "")
            ? conversion.tables
            : null;
        const documentBlock =
          conversion?.status === "failed"
            ? { reason: `document_${conversion.reason ?? "failed"}`, detail: conversion.reason }
            : !tables &&
                conversion?.status === "done" &&
                (conversion.dataRows ?? 0) > maxSingleCallRows
              ? {
                  reason: "requires_chunked_extraction",
                  detail: `${conversion.dataRows} product lines > ${maxSingleCallRows}: needs chunked extraction`,
                }
              : null;
        if (documentBlock) {
          await deps.repository.saveExtraction(run.id, {
            status: "needs_review",
            classification: run.classification,
            errors: documentBlock,
          });
          log.warn({ runId: run.id, reason: documentBlock.reason }, "document not extracted");
          return summary((await deps.repository.getRun(run.id)) ?? run);
        }
        if (tables && deps.sheets) {
          const sheetResult = await deps.sheets.extract(
            {
              runId: run.id,
              messageId: run.messageId,
              contactId: ctx.contact.id,
              supplierId: ctx.contact.supplierId,
              tables,
              catalog,
              log,
            },
            { ingestionRunId: run.id, messageId: run.messageId, contactId: ctx.contact.id, log },
          );
          if (sheetResult.kind === "mapping_required") {
            const reason =
              sheetResult.proposal.reason === "format_changed"
                ? "sheet_format_changed"
                : "column_mapping_required";
            await deps.repository.saveExtraction(run.id, {
              status: "needs_review",
              classification: run.classification,
              errors: { reason },
              gate: {
                kind: "column_mapping",
                reasons: [reason],
                proposal: sheetResult.proposal as unknown as never,
              },
            });
            log.info({ runId: run.id, reason }, "spreadsheet format needs a reviewed mapping");
            return summary((await deps.repository.getRun(run.id)) ?? run);
          }
          const sheetOutput = applyDocumentRules(
            applyExtractionRules(sheetResult.output, catalog.refNames, language),
            conversion,
            language,
          );
          const stored: StoredExtraction = {
            output: sheetOutput,
            refs: Object.fromEntries(catalog.refs),
            byNormalizedName: Object.fromEntries(catalog.byNormalizedName),
            catalogTruncated: catalog.truncated,
            promptVersion: `sheet-formats:${sheetResult.formatIds.join(",")}`,
            sheetFormatIds: sheetResult.formatIds,
            ...(conversion?.needsReview ? { documentIncomplete: true } : {}),
          };
          await deps.repository.saveExtraction(run.id, {
            status: sheetOutput.suspiciousInstructions ? "needs_review" : "extracted",
            classification: !sheetOutput.isPriceList
              ? "other"
              : sheetOutput.listKind === "full_list"
                ? "price_list_full"
                : "price_update_partial",
            rawExtraction: stored as unknown as never,
            ...(sheetOutput.suspiciousInstructions
              ? { errors: { reason: "suspicious_instructions" } }
              : {}),
          });
          return summary((await deps.repository.getRun(run.id)) ?? run);
        }
        const content = buildExtractionContent(await messageForAi(ctx, true), catalog.text);
        if (!content.ok) {
          await deps.repository.saveExtraction(run.id, {
            status: "needs_review",
            classification: run.classification,
            errors: { reason: content.reason },
          });
          return summary((await deps.repository.getRun(run.id)) ?? run);
        }

        const result = await deps.ai.generateStructured(
          {
            task: "extract",
            model: deps.models.extractor,
            system: extractor.text,
            cacheSystem: deps.models.cacheSystemPrompts,
            content: content.content,
            jsonSchema: extractionJsonSchema as unknown as Record<string, unknown>,
            schema: extractionSchema,
            effort: "medium",
            maxTokens: 6000,
            language,
          },
          {
            promptVersion: extractor.version,
            ingestionRunId: run.id,
            messageId: run.messageId,
            contactId: ctx.contact.id,
            log,
          },
        );

        const output = applyDocumentRules(
          applyExtractionRules(result.data, catalog.refNames, language),
          conversion?.status === "done" ? conversion : null,
          language,
        );
        const classification: IngestionClassification = !output.isPriceList
          ? "other"
          : output.listKind === "full_list"
            ? "price_list_full"
            : "price_update_partial";
        const stored: StoredExtraction = {
          output,
          refs: Object.fromEntries(catalog.refs),
          byNormalizedName: Object.fromEntries(catalog.byNormalizedName),
          catalogTruncated: catalog.truncated,
          promptVersion: extractor.version,
          ...(conversion?.needsReview ? { documentIncomplete: true } : {}),
        };
        // Injected instructions → a human reviews the run before it touches the catalog.
        await deps.repository.saveExtraction(run.id, {
          status: output.suspiciousInstructions ? "needs_review" : "extracted",
          classification,
          rawExtraction: stored as unknown as never,
          ...(output.suspiciousInstructions
            ? { errors: { reason: "suspicious_instructions" } }
            : {}),
        });
        log.info(
          {
            runId: run.id,
            items: output.items.length,
            listKind: output.listKind,
            suspiciousInstructions: output.suspiciousInstructions,
            costUsd: result.costUsd,
          },
          "price list extracted",
        );
      } catch (err) {
        await handleAiFailure(err, run.id, "extract", log);
      } finally {
        await deps.repository.refreshUsageTotals(run.id);
      }
      return summary((await deps.repository.getRun(run.id)) ?? run);
    },

    async getRun(runId) {
      const run = await deps.repository.getRunDetail(runId);
      if (!run) throw errors.notFound("Ingestion run not found");
      const stored = run.rawExtraction as StoredExtraction | null;
      const report = run.report as {
        counts?: unknown;
        pendingReviews?: number;
        gate?: unknown;
      } | null;
      const ingested = report && ("counts" in report || "gate" in report);
      return {
        runId: run.id,
        messageId: run.messageId,
        status: run.status,
        classification: run.classification,
        supplierId: run.supplierId,
        prefilterRule: run.prefilterRule,
        itemCount: stored?.output ? stored.output.items.length : null,
        listKind: stored?.output?.listKind ?? null,
        suspiciousInstructions: stored?.output?.suspiciousInstructions ?? null,
        errors: run.errors,
        ingest: ingested
          ? {
              counts: report.counts ?? null,
              pendingReviews: report.pendingReviews ?? 0,
              gate: report.gate ?? null,
            }
          : null,
        reviewItems: run.reviewItems,
        document: run.document,
        costUsd: run.costUsd,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      };
    },
  };

  async function handleAiFailure(
    err: unknown,
    runId: string,
    task: "classify" | "extract",
    log: Logger,
  ) {
    const save = (reason: string, detail: string) =>
      task === "classify"
        ? deps.repository.saveClassification(runId, {
            status: "needs_review",
            classification: null,
            report: { reason },
            errors: { reason, detail },
          })
        : deps.repository.saveExtraction(runId, {
            status: "needs_review",
            classification: null,
            errors: { reason, detail },
          });

    if (err instanceof BudgetExceededError) {
      await save("budget_exceeded", err.message);
      return;
    }
    if (err instanceof LlmError && !err.retryable) {
      await save(`llm_${err.kind}`, err.message);
      return;
    }
    // Transient (timeout, rate limit, overloaded): release so the caller can retry.
    if (task === "extract") await deps.repository.releaseClaim(runId);
    log.warn({ runId, task, err }, "AI call failed transiently; the run can be retried");
    throw errors.serviceUnavailable("AI provider temporarily unavailable, retry later");
  }
}
