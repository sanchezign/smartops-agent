import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { DocumentConversionStatus, MediaStatus } from "../../generated/prisma/enums.js";
import type { OnMediaStoredInTx } from "../media/media.repository.js";
import { documentFormat, type ConversionResult } from "./document-types.js";

/** Document conversions. The only place in the conversion flow that touches Prisma. */

export interface ConversionForProcessing {
  mediaFileId: string;
  status: DocumentConversionStatus;
  mimeType: string;
  filename: string | null;
  mediaStatus: MediaStatus;
}

export interface DocumentConversionRepository {
  getForProcessing(mediaFileId: string): Promise<ConversionForProcessing | null>;
  incrementAttempts(mediaFileId: string): Promise<void>;
  /** pending → done (no-op if no longer pending). */
  markDone(
    mediaFileId: string,
    result: Extract<ConversionResult, { ok: true }>,
    meta: { durationMs: number; converterVersion: string },
  ): Promise<void>;
  /** pending → failed with a machine-readable reason. */
  markFailed(
    mediaFileId: string,
    input: { reason: string; detail: string | null; durationMs: number | null },
  ): Promise<void>;
  recordError(mediaFileId: string, error: string): Promise<void>;
}

/** Creates the pending conversion row (idempotent) inside the caller's transaction. */
export async function createPendingConversionInTx(
  tx: Prisma.TransactionClient,
  mediaFileId: string,
): Promise<void> {
  await tx.documentConversion.upsert({
    where: { mediaFileId },
    create: { mediaFileId },
    update: {},
  });
}

/**
 * Media-stored hook for convertible documents (xlsx/xls/csv/txt/docx; PDF and images are
 * sent to Claude as-is): pending conversion row + job, in the same transaction.
 */
export function createOnDocumentStoredInTx(deps: {
  enqueueConversionInTx: (tx: Prisma.TransactionClient, mediaFileId: string) => Promise<void>;
}): OnMediaStoredInTx {
  return async (tx, media) => {
    if (media.kind !== "document" || documentFormat(media.mimeType, null) === null) return;
    await createPendingConversionInTx(tx, media.mediaFileId);
    await deps.enqueueConversionInTx(tx, media.mediaFileId);
  };
}

const truncate = (value: string) => (value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value);

export function createDocumentConversionRepository(
  prisma: PrismaClient,
): DocumentConversionRepository {
  return {
    async getForProcessing(mediaFileId) {
      const row = await prisma.documentConversion.findUnique({
        where: { mediaFileId },
        select: {
          mediaFileId: true,
          status: true,
          mediaFile: { select: { mimeType: true, filename: true, status: true } },
        },
      });
      if (!row) return null;
      return {
        mediaFileId: row.mediaFileId,
        status: row.status,
        mimeType: row.mediaFile.mimeType,
        filename: row.mediaFile.filename,
        mediaStatus: row.mediaFile.status,
      };
    },

    async incrementAttempts(mediaFileId) {
      await prisma.documentConversion.update({
        where: { mediaFileId },
        data: { attempts: { increment: 1 } },
      });
    },

    async markDone(mediaFileId, result, meta) {
      await prisma.documentConversion.updateMany({
        where: { mediaFileId, status: "pending" },
        data: {
          status: "done",
          format: result.format,
          text: result.text,
          charCount: result.charCount,
          dataRows: result.dataRows,
          truncated: result.truncated,
          needsReview: result.needsReview,
          sheets: result.sheets as unknown as Prisma.InputJsonValue,
          tables: result.tables as unknown as Prisma.InputJsonValue,
          warnings: result.warnings as unknown as Prisma.InputJsonValue,
          durationMs: meta.durationMs,
          converterVersion: meta.converterVersion,
          completedAt: new Date(),
          reason: null,
          error: null,
        },
      });
    },

    async markFailed(mediaFileId, input) {
      await prisma.documentConversion.updateMany({
        where: { mediaFileId, status: "pending" },
        data: {
          status: "failed",
          reason: input.reason,
          error: input.detail ? truncate(input.detail) : null,
          durationMs: input.durationMs,
          completedAt: new Date(),
        },
      });
    },

    async recordError(mediaFileId, error) {
      await prisma.documentConversion.updateMany({
        where: { mediaFileId },
        data: { error: truncate(error) },
      });
    },
  };
}
