import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type {
  DocumentConversionStatus,
  IngestionClassification,
  IngestionStatus,
  MediaStatus,
  TranscriptionStatus,
} from "../../generated/prisma/enums.js";
import type { CatalogProduct } from "./catalog-context.js";

/** Ingestion runs (classification + extraction). The only place in the flow touching Prisma. */

export interface MessageContext {
  messageId: string;
  messageType: string;
  direction: string;
  text: string | null;
  transcript: string | null;
  contact: { id: string; kind: string; name: string | null; supplierId: string | null };
  supplier: { id: string; name: string } | null;
  media: {
    id: string;
    status: MediaStatus;
    mimeType: string;
    filename: string | null;
    transcriptionStatus: TranscriptionStatus | null;
    /** Conversion of spreadsheets / CSV / text / Word (phase 5 M3a). */
    conversion: DocumentConversionInfo | null;
  } | null;
}

export interface DocumentConversionInfo {
  status: DocumentConversionStatus;
  reason: string | null;
  format: string | null;
  text: string | null;
  dataRows: number | null;
  truncated: boolean;
  needsReview: boolean;
  warnings: { code: string; message: string }[];
}

/** GET /api/v1/internal/runs/:id — everything n8n needs to follow a run. */
export interface RunDetail {
  id: string;
  messageId: string;
  status: IngestionStatus;
  classification: IngestionClassification | null;
  supplierId: string | null;
  rawExtraction: unknown;
  report: unknown;
  errors: unknown;
  costUsd: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  reviewItems: { id: string; scope: string; kind: string; status: string }[];
  document: {
    status: DocumentConversionStatus;
    format: string | null;
    reason: string | null;
    dataRows: number | null;
    truncated: boolean;
    needsReview: boolean;
  } | null;
}

export interface IngestionRunRecord {
  id: string;
  messageId: string;
  supplierId: string | null;
  status: IngestionStatus;
  classification: IngestionClassification | null;
  rawExtraction: unknown;
  report: unknown;
  errors: unknown;
  costUsd: string | null;
}

export interface IngestionRepository {
  getMessageContext(messageId: string): Promise<MessageContext | null>;
  getSupplierCatalog(supplierId: string): Promise<CatalogProduct[]>;
  /** Latest run of the message that is not failed. */
  findActiveRun(messageId: string): Promise<IngestionRunRecord | null>;
  getRun(runId: string): Promise<IngestionRunRecord | null>;
  getRunDetail(runId: string): Promise<RunDetail | null>;
  createRun(messageId: string, supplierId: string | null): Promise<IngestionRunRecord>;
  saveClassification(
    runId: string,
    input: {
      status: "classified" | "needs_review";
      classification: IngestionClassification | null;
      report: Prisma.InputJsonValue;
      errors?: Prisma.InputJsonValue;
    },
  ): Promise<void>;
  /** Atomic classified → extracting. False when another request holds it or the state differs. */
  claimForExtraction(runId: string): Promise<boolean>;
  /** extracting → classified (after a retryable failure, so it can be retried). */
  releaseClaim(runId: string): Promise<void>;
  saveExtraction(
    runId: string,
    input: {
      status: "extracted" | "needs_review";
      classification: IngestionClassification | null;
      rawExtraction?: Prisma.InputJsonValue;
      errors?: Prisma.InputJsonValue;
    },
  ): Promise<void>;
  /** Recomputes tokens / cost / latency / model / prompt version from ai_usages. */
  refreshUsageTotals(runId: string): Promise<void>;
}

const runSelect = {
  id: true,
  messageId: true,
  supplierId: true,
  status: true,
  classification: true,
  rawExtraction: true,
  report: true,
  errors: true,
  costUsd: true,
} as const;

function toRecord(row: {
  id: string;
  messageId: string;
  supplierId: string | null;
  status: IngestionStatus;
  classification: IngestionClassification | null;
  rawExtraction: unknown;
  report: unknown;
  errors: unknown;
  costUsd: { toString(): string } | null;
}): IngestionRunRecord {
  return { ...row, costUsd: row.costUsd ? row.costUsd.toString() : null };
}

/**
 * A run that ends in needs_review gets a run-level review item (ADR-012), so a human sees
 * it in the review queue: suspicious_instructions (the extraction is kept) or
 * extraction_failed (budget, invalid output, unsupported content → retry or reject).
 * Numbered dedupe key: a retried extraction that fails again gets a new item.
 */
async function createReviewGate(
  tx: Prisma.TransactionClient,
  runId: string,
  supplierId: string | null,
  task: "classify" | "extract",
  runErrors: Prisma.InputJsonValue | undefined,
): Promise<void> {
  const errorInfo = (runErrors ?? {}) as { reason?: string; detail?: string };
  const reason = errorInfo.reason ?? "unknown";
  const kind =
    reason === "suspicious_instructions" ? "suspicious_instructions" : "extraction_failed";
  const previous = await tx.reviewItem.count({ where: { ingestionRunId: runId, kind } });
  await tx.reviewItem.create({
    data: {
      ingestionRunId: runId,
      supplierId,
      scope: "run",
      kind,
      dedupeKey: `gate:${kind}:${previous + 1}`,
      reasons: [reason],
      proposal: { task, reason, detail: errorInfo.detail ?? null },
    },
  });
}

export function createIngestionRepository(prisma: PrismaClient): IngestionRepository {
  return {
    async getMessageContext(messageId) {
      const m = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          type: true,
          direction: true,
          text: true,
          transcript: true,
          conversation: {
            select: {
              contact: {
                select: {
                  id: true,
                  kind: true,
                  name: true,
                  supplierId: true,
                  supplier: { select: { id: true, name: true } },
                },
              },
            },
          },
          mediaFile: {
            select: {
              id: true,
              status: true,
              mimeType: true,
              filename: true,
              transcription: { select: { status: true } },
              documentConversion: {
                select: {
                  status: true,
                  reason: true,
                  format: true,
                  text: true,
                  dataRows: true,
                  truncated: true,
                  needsReview: true,
                  warnings: true,
                },
              },
            },
          },
        },
      });
      if (!m) return null;
      const contact = m.conversation.contact;
      return {
        messageId: m.id,
        messageType: m.type,
        direction: m.direction,
        text: m.text,
        transcript: m.transcript,
        contact: {
          id: contact.id,
          kind: contact.kind,
          name: contact.name,
          supplierId: contact.supplierId,
        },
        supplier: contact.supplier,
        media: m.mediaFile
          ? {
              id: m.mediaFile.id,
              status: m.mediaFile.status,
              mimeType: m.mediaFile.mimeType,
              filename: m.mediaFile.filename,
              transcriptionStatus: m.mediaFile.transcription?.status ?? null,
              conversion: m.mediaFile.documentConversion
                ? {
                    ...m.mediaFile.documentConversion,
                    warnings: (m.mediaFile.documentConversion.warnings ??
                      []) as DocumentConversionInfo["warnings"],
                  }
                : null,
            }
          : null,
      };
    },

    async getSupplierCatalog(supplierId) {
      const rows = await prisma.product.findMany({
        where: { supplierId },
        select: { id: true, name: true, unit: true, price: true, currency: true, available: true },
      });
      return rows.map((r) => ({ ...r, price: r.price.toString() }));
    },

    async findActiveRun(messageId) {
      const row = await prisma.ingestionRun.findFirst({
        where: { messageId, status: { not: "failed" } },
        orderBy: { createdAt: "desc" },
        select: runSelect,
      });
      return row ? toRecord(row) : null;
    },

    async getRun(runId) {
      const row = await prisma.ingestionRun.findUnique({ where: { id: runId }, select: runSelect });
      return row ? toRecord(row) : null;
    },

    async getRunDetail(runId) {
      const row = await prisma.ingestionRun.findUnique({
        where: { id: runId },
        select: {
          ...runSelect,
          createdAt: true,
          finishedAt: true,
          reviewItems: {
            select: { id: true, scope: true, kind: true, status: true },
            orderBy: { createdAt: "asc" },
          },
          message: {
            select: {
              mediaFile: {
                select: {
                  documentConversion: {
                    select: {
                      status: true,
                      format: true,
                      reason: true,
                      dataRows: true,
                      truncated: true,
                      needsReview: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!row) return null;
      const { message, costUsd, ...rest } = row;
      return {
        ...rest,
        costUsd: costUsd ? costUsd.toString() : null,
        document: message.mediaFile?.documentConversion ?? null,
      };
    },

    async createRun(messageId, supplierId) {
      const row = await prisma.ingestionRun.create({
        data: { messageId, supplierId, status: "pending" },
        select: runSelect,
      });
      return toRecord(row);
    },

    async saveClassification(runId, input) {
      await prisma.$transaction(async (tx) => {
        const run = await tx.ingestionRun.update({
          where: { id: runId },
          data: {
            status: input.status,
            classification: input.classification,
            report: input.report,
            ...(input.errors ? { errors: input.errors } : {}),
            ...(input.status === "needs_review" ? { finishedAt: new Date() } : {}),
          },
          select: { supplierId: true },
        });
        if (input.status === "needs_review")
          await createReviewGate(tx, runId, run.supplierId, "classify", input.errors);
      });
    },

    async claimForExtraction(runId) {
      const claimed = await prisma.ingestionRun.updateMany({
        where: { id: runId, status: "classified" },
        data: { status: "extracting" },
      });
      return claimed.count === 1;
    },

    async releaseClaim(runId) {
      await prisma.ingestionRun.updateMany({
        where: { id: runId, status: "extracting" },
        data: { status: "classified" },
      });
    },

    async saveExtraction(runId, input) {
      await prisma.$transaction(async (tx) => {
        const saved = await tx.ingestionRun.updateMany({
          where: { id: runId, status: "extracting" },
          data: {
            status: input.status,
            classification: input.classification,
            ...(input.rawExtraction ? { rawExtraction: input.rawExtraction } : {}),
            ...(input.errors ? { errors: input.errors } : {}),
            ...(input.status === "needs_review" ? { finishedAt: new Date() } : {}),
          },
        });
        if (saved.count === 1 && input.status === "needs_review") {
          const run = await tx.ingestionRun.findUniqueOrThrow({
            where: { id: runId },
            select: { supplierId: true },
          });
          await createReviewGate(tx, runId, run.supplierId, "extract", input.errors);
        }
      });
    },

    async refreshUsageTotals(runId) {
      const [sums, last] = await Promise.all([
        prisma.aiUsage.aggregate({
          where: { ingestionRunId: runId },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            costUsd: true,
            latencyMs: true,
          },
        }),
        prisma.aiUsage.findFirst({
          where: { ingestionRunId: runId, status: "ok" },
          orderBy: { createdAt: "desc" },
          select: { model: true, promptVersion: true },
        }),
      ]);
      await prisma.ingestionRun.update({
        where: { id: runId },
        data: {
          inputTokens: sums._sum.inputTokens ?? 0,
          outputTokens: sums._sum.outputTokens ?? 0,
          cacheReadTokens: sums._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: sums._sum.cacheWriteTokens ?? 0,
          costUsd: sums._sum.costUsd ?? 0,
          latencyMs: sums._sum.latencyMs ?? null,
          ...(last ? { model: last.model, promptVersion: last.promptVersion } : {}),
        },
      });
    },
  };
}
