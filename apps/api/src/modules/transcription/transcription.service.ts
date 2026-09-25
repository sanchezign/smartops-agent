import type { Logger } from "../../common/logger.js";
import { audioDurationSeconds, UNKNOWN_DURATION_LONG_BYTES } from "../media/audio-duration.js";
import { normalizeMime } from "../media/media-policy.js";
import type { MediaStorage } from "../media/media-storage.js";
import type { TranscriptionRepository } from "./transcription.repository.js";
import { TranscriptionError, type Transcriber } from "./transcriber.js";

/**
 * Transcribes one stored audio file (called by the pg-boss worker). Never blocks the
 * message pipeline: permanent problems end in skipped/failed without throwing; transient
 * ones throw so pg-boss retries. The transcript text is NEVER logged (personal data).
 */

export type TranscriptionOutcome = "done" | "skipped" | "failed" | "already_done" | "not_found";

export interface TranscribedContext {
  mediaFileId: string;
  messageId: string | null;
  log: Logger;
}

/** Extension point: phase 5/6 (hand the transcribed message to extraction / n8n). */
export type TranscribedHook = (ctx: TranscribedContext) => Promise<void>;

export interface TranscriptionService {
  processTranscription(
    mediaFileId: string,
    log: Logger,
  ): Promise<{ outcome: TranscriptionOutcome; reason?: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createTranscriptionService(deps: {
  repository: TranscriptionRepository;
  storage: MediaStorage;
  transcriber: Transcriber;
  language: string;
  prompt?: string;
  /** Max transcriptions per contact in a rolling 24h window (quota protection). */
  dailyLimitPerContact: number;
  onTranscribed?: TranscribedHook;
  /** Setting transcription.maxAutoDurationSeconds (read per job: editable from the panel). */
  maxAutoDurationSeconds?: () => Promise<number>;
  now?: () => Date;
}): TranscriptionService {
  const now = deps.now ?? (() => new Date());

  return {
    async processTranscription(mediaFileId, log) {
      const item = await deps.repository.getForProcessing(mediaFileId);
      if (!item) {
        log.warn({ mediaFileId }, "transcription not found");
        return { outcome: "not_found" };
      }
      if (item.status !== "pending") {
        log.debug({ mediaFileId, status: item.status }, "transcription already handled");
        return { outcome: "already_done" };
      }
      await deps.repository.incrementAttempts(mediaFileId);

      const finish = async (status: "skipped" | "failed", reason: string, error?: string) => {
        await deps.repository.markFinal(mediaFileId, status, reason, error);
        log[status === "skipped" ? "info" : "warn"](
          { mediaFileId, reason, mimeType: normalizeMime(item.mimeType) },
          `transcription ${status}`,
        );
        return { outcome: status, reason } as const;
      };

      if (!deps.transcriber.supports(item.mimeType)) {
        return finish("skipped", "unsupported_format");
      }
      if (item.contactId) {
        const used = await deps.repository.countDoneForContactSince(
          item.contactId,
          new Date(now().getTime() - DAY_MS),
        );
        if (used >= deps.dailyLimitPerContact) {
          return finish("skipped", "quota_exceeded", `${used} transcriptions in the last 24h`);
        }
      }

      const bytes = await deps.storage.get(mediaFileId);
      if (!bytes) return finish("failed", "media_missing", "audio bytes not found in storage");

      // Long voice notes are not transcribed automatically (phase 6): listen by hand.
      if (deps.maxAutoDurationSeconds) {
        const maxSeconds = await deps.maxAutoDurationSeconds();
        const durationSeconds = audioDurationSeconds(bytes, item.mimeType);
        const tooLong =
          durationSeconds === null
            ? bytes.byteLength > UNKNOWN_DURATION_LONG_BYTES
            : durationSeconds > maxSeconds;
        if (tooLong) {
          await deps.repository.markTooLong(mediaFileId, {
            durationSeconds,
            sizeBytes: bytes.byteLength,
            maxSeconds,
          });
          log.info(
            { mediaFileId, durationSeconds, sizeBytes: bytes.byteLength, maxSeconds },
            "voice note too long: not transcribed (manual attention)",
          );
          return { outcome: "skipped", reason: "too_long" };
        }
      }

      let result;
      try {
        result = await deps.transcriber.transcribe({
          bytes,
          mimeType: item.mimeType,
          language: deps.language,
          ...(deps.prompt ? { prompt: deps.prompt } : {}),
        });
      } catch (err) {
        if (err instanceof TranscriptionError) {
          if (!err.retryable) return finish("failed", err.kind, err.message);
          if (err.kind === "unauthorized") {
            log.error(
              { provider: deps.transcriber.provider },
              "transcription API key invalid: fix TRANSCRIPTION_API_KEY (will retry)",
            );
          } else {
            log.warn(
              {
                mediaFileId,
                kind: err.kind,
                httpStatus: err.httpStatus,
                retryAfterSeconds: err.retryAfterSeconds,
              },
              "transcription failed (will retry)",
            );
          }
        }
        throw err;
      }

      await deps.repository.markDone(mediaFileId, {
        text: result.text,
        provider: result.provider,
        model: result.model,
        language: result.language ?? deps.language,
        durationSeconds: result.durationSeconds,
        latencyMs: result.latencyMs,
      });
      log.info(
        {
          mediaFileId,
          messageId: item.messageId,
          provider: result.provider,
          model: result.model,
          chars: result.text.length,
          durationSeconds: result.durationSeconds,
          latencyMs: result.latencyMs,
        },
        "voice note transcribed",
      );
      if (deps.onTranscribed) {
        await deps.onTranscribed({ mediaFileId, messageId: item.messageId, log });
      }
      return { outcome: "done" };
    },
  };
}
