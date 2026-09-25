import type { Logger } from "../../common/logger.js";
import type { MediaStorage } from "../media/media-storage.js";
import type { DocumentConversionRepository } from "./document-conversion.repository.js";
import type { DocumentConverter } from "./document-converter.js";

/**
 * Converts one stored document (worker job, phase 5 M3a).
 * - Already done/failed → skip (idempotent: a duplicate job does nothing).
 * - Rejections (bomb, encrypted, too large, timeout, out of memory…) are PERMANENT: the
 *   conversion is marked failed and the extraction sends the run to human review.
 * - Only unexpected errors (DB, storage) throw → the queue retries with backoff.
 * The converted text is never logged (only sizes, format and warning codes).
 */

export const CONVERTER_VERSION = "m3a-1 (xlsx 0.20.3, mammoth 1.12.3, csv-parse 7.0.2)";

export interface DocumentConversionService {
  processConversion(
    mediaFileId: string,
    log: Logger,
  ): Promise<{ status: "done" | "failed" | "skipped"; reason?: string }>;
}

export function createDocumentConversionService(deps: {
  repository: DocumentConversionRepository;
  storage: MediaStorage;
  converter: DocumentConverter;
  now?: () => number;
}): DocumentConversionService {
  const now = deps.now ?? (() => Date.now());
  return {
    async processConversion(mediaFileId, log) {
      const row = await deps.repository.getForProcessing(mediaFileId);
      if (!row) return { status: "skipped", reason: "missing" };
      if (row.status !== "pending") return { status: "skipped", reason: row.status };
      if (row.mediaStatus !== "stored") {
        throw new Error(`media ${mediaFileId} is ${row.mediaStatus}, expected stored`);
      }
      const bytes = await deps.storage.get(mediaFileId);
      if (!bytes) throw new Error(`no stored bytes for media ${mediaFileId}`);

      await deps.repository.incrementAttempts(mediaFileId);
      const started = now();
      const result = await deps.converter.convert({
        bytes,
        mimeType: row.mimeType,
        filename: row.filename,
      });
      const durationMs = now() - started;

      if (!result.ok) {
        await deps.repository.markFailed(mediaFileId, {
          reason: result.reason,
          detail: result.detail ?? null,
          durationMs,
        });
        log.warn(
          { mediaFileId, reason: result.reason, bytes: bytes.byteLength, durationMs },
          "document conversion rejected",
        );
        return { status: "failed", reason: result.reason };
      }
      await deps.repository.markDone(mediaFileId, result, {
        durationMs,
        converterVersion: CONVERTER_VERSION,
      });
      log.info(
        {
          mediaFileId,
          format: result.format,
          bytes: bytes.byteLength,
          chars: result.charCount,
          dataRows: result.dataRows,
          sheets: result.sheets.length,
          truncated: result.truncated,
          needsReview: result.needsReview,
          warnings: result.warnings.map((w) => w.code),
          durationMs,
        },
        "document converted",
      );
      return { status: "done" };
    },
  };
}
