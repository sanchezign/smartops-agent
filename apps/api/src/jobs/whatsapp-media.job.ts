import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { MediaRepository } from "../modules/media/media.repository.js";
import type { MediaDownloadService } from "../modules/media/media.service.js";
import { QUEUES, type MediaDownloadJob } from "./queues.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Registers the media workers:
 * - whatsapp-media: download + store one MediaFile (throws → retry with backoff).
 * - whatsapp-media-dlq: retries exhausted → MediaFile failed (retries_exhausted).
 */
export async function registerWhatsAppMediaWorkers(
  boss: PgBoss,
  deps: {
    service: MediaDownloadService;
    repository: Pick<MediaRepository, "recordError" | "markFinal">;
    logger: Logger;
    concurrency: number;
  },
): Promise<void> {
  await boss.work(
    QUEUES.whatsappMedia,
    { includeMetadata: true, localConcurrency: deps.concurrency },
    async ([job]: JobWithMetadata<MediaDownloadJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        mediaFileId: job.data.mediaFileId,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      try {
        const result = await deps.service.processMediaFile(job.data.mediaFileId, log);
        log.debug(result, "media job handled");
      } catch (err) {
        log.error({ err }, "media download failed (will retry)");
        await deps.repository
          .recordError(job.data.mediaFileId, errorMessage(err))
          .catch((recordErr: unknown) => log.error({ err: recordErr }, "could not record error"));
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.whatsappMediaDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<MediaDownloadJob>[]) => {
      if (!job) return;
      await deps.repository.markFinal(job.data.mediaFileId, "failed", "retries_exhausted");
      deps.logger.error(
        { jobId: job.id, mediaFileId: job.data.mediaFileId, sourceQueue: job.sourceName },
        "media download permanently failed (dead letter): see media_files.error; retry with wa:media:retry",
      );
    },
  );
}
