import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { TranscriptionRepository } from "../modules/transcription/transcription.repository.js";
import type { TranscriptionService } from "../modules/transcription/transcription.service.js";
import { QUEUES, type TranscriptionJob } from "./queues.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Registers the transcription workers:
 * - media-transcription: transcribe one stored audio (throws → retry with backoff).
 * - media-transcription-dlq: retries exhausted → transcription failed. The message
 *   itself stays available (a failed transcript never blocks the pipeline).
 */
export async function registerMediaTranscriptionWorkers(
  boss: PgBoss,
  deps: {
    service: TranscriptionService;
    repository: Pick<TranscriptionRepository, "recordError" | "markFinal">;
    logger: Logger;
    concurrency: number;
  },
): Promise<void> {
  await boss.work(
    QUEUES.mediaTranscription,
    { includeMetadata: true, localConcurrency: deps.concurrency },
    async ([job]: JobWithMetadata<TranscriptionJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        mediaFileId: job.data.mediaFileId,
        attempt: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      });
      try {
        const result = await deps.service.processTranscription(job.data.mediaFileId, log);
        log.debug(result, "transcription job handled");
      } catch (err) {
        await deps.repository
          .recordError(job.data.mediaFileId, errorMessage(err))
          .catch((recordErr: unknown) => log.error({ err: recordErr }, "could not record error"));
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.mediaTranscriptionDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<TranscriptionJob>[]) => {
      if (!job) return;
      await deps.repository.markFinal(job.data.mediaFileId, "failed", "retries_exhausted");
      deps.logger.error(
        { jobId: job.id, mediaFileId: job.data.mediaFileId },
        "transcription permanently failed (dead letter): retry with wa:transcription:retry",
      );
    },
  );
}
