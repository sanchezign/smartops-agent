import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { DocumentConversionRepository } from "../modules/documents/document-conversion.repository.js";
import type { DocumentConversionService } from "../modules/documents/document-conversion.service.js";
import { QUEUES, type DocumentConversionJob } from "./queues.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Registers the document conversion workers (phase 5 M3a):
 * - document-conversion: convert one stored document in an isolated thread.
 * - document-conversion-dlq: retries exhausted (storage/DB errors) → failed.
 */
export async function registerDocumentConversionWorkers(
  boss: PgBoss,
  deps: {
    service: DocumentConversionService;
    repository: Pick<DocumentConversionRepository, "recordError" | "markFailed">;
    logger: Logger;
    concurrency: number;
  },
): Promise<void> {
  await boss.work(
    QUEUES.documentConversion,
    { includeMetadata: true, localConcurrency: deps.concurrency },
    async ([job]: JobWithMetadata<DocumentConversionJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        mediaFileId: job.data.mediaFileId,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      try {
        const result = await deps.service.processConversion(job.data.mediaFileId, log);
        log.debug(result, "document conversion job handled");
      } catch (err) {
        await deps.repository
          .recordError(job.data.mediaFileId, errorMessage(err))
          .catch((recordErr: unknown) => log.error({ err: recordErr }, "could not record error"));
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.documentConversionDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<DocumentConversionJob>[]) => {
      if (!job) return;
      await deps.repository.markFailed(job.data.mediaFileId, {
        reason: "retries_exhausted",
        detail: null,
        durationMs: null,
      });
      deps.logger.error(
        { jobId: job.id, mediaFileId: job.data.mediaFileId },
        "document conversion permanently failed (dead letter)",
      );
    },
  );
}
