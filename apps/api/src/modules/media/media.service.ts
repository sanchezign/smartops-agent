import type { Logger } from "../../common/logger.js";
import {
  MediaDownloadError,
  type MediaInfo,
  type WhatsAppMediaClient,
} from "../whatsapp/whatsapp-media.client.js";
import {
  contentMatchesMime,
  effectiveMaxBytes,
  planMedia,
  sha256Matches,
  type MediaKind,
} from "./media-policy.js";
import type { MediaStorage } from "./media-storage.js";
import type { MediaRepository } from "./media.repository.js";

/**
 * Downloads one WhatsApp media file and stores it (ADR-008). Called by the pg-boss
 * worker. Permanent problems end in `rejected` / `failed` / `skipped` WITHOUT throwing
 * (no retry); transient ones throw, so pg-boss retries with backoff.
 */

export type MediaOutcome =
  "stored" | "skipped" | "rejected" | "failed" | "already_done" | "not_found";

export interface MediaStoredContext {
  mediaFileId: string;
  mimeType: string;
  kind: MediaKind;
  log: Logger;
}

/** Extension point: phase 4 (transcribe voice notes) / phase 5 (extraction). */
export type MediaStoredHook = (ctx: MediaStoredContext) => Promise<void>;

export interface MediaDownloadService {
  processMediaFile(
    mediaFileId: string,
    log: Logger,
  ): Promise<{ outcome: MediaOutcome; reason?: string }>;
}

export function createMediaDownloadService(deps: {
  repository: MediaRepository;
  storage: MediaStorage;
  client: WhatsAppMediaClient;
  /** MEDIA_MAX_BYTES. */
  maxBytes: number;
  onMediaStored?: MediaStoredHook;
}): MediaDownloadService {
  return {
    async processMediaFile(mediaFileId, log) {
      const file = await deps.repository.getForDownload(mediaFileId);
      if (!file) {
        log.warn({ mediaFileId }, "media file not found");
        return { outcome: "not_found" };
      }
      if (file.status !== "pending") {
        log.debug({ mediaFileId, status: file.status }, "media already handled, skipping");
        return { outcome: "already_done" };
      }
      await deps.repository.incrementAttempts(mediaFileId);

      const finish = async (
        status: "rejected" | "skipped" | "failed",
        reason: string,
        detail?: string,
      ) => {
        await deps.repository.markFinal(mediaFileId, status, reason, detail);
        const level = status === "skipped" ? "info" : "warn";
        log[level]({ mediaFileId, reason, ...(detail ? { detail } : {}) }, `media ${status}`);
        return { outcome: status, reason } as const;
      };

      const messageType = file.messageType ?? "document";
      const declared = planMedia(messageType, file.mimeType);
      if (declared.action === "skip") return finish("skipped", declared.reason);
      if (declared.action === "reject") {
        return finish("rejected", declared.reason, `declared mime ${file.mimeType}`);
      }

      const getInfo = async (): Promise<MediaInfo> => {
        try {
          return await deps.client.getMediaInfo(file.waMediaId);
        } catch (err) {
          throw logIfUnauthorized(err, log);
        }
      };

      let info: MediaInfo;
      try {
        info = await getInfo();
      } catch (err) {
        if (err instanceof MediaDownloadError && err.kind === "not_found") {
          return finish("failed", "media_not_found", err.message);
        }
        throw err;
      }

      // Validate again with what Meta's media API reports (source of truth).
      const actual = planMedia(messageType, info.mimeType);
      if (actual.action !== "download") {
        return finish("rejected", "unsupported_mime", `media API mime ${info.mimeType}`);
      }
      const maxBytes = effectiveMaxBytes(actual.kind, deps.maxBytes);
      if (info.fileSize !== null && info.fileSize > maxBytes) {
        return finish("rejected", "too_large", `${info.fileSize} bytes > ${maxBytes}`);
      }

      const started = Date.now();
      let downloaded;
      try {
        try {
          downloaded = await deps.client.download(info.url, { maxBytes });
        } catch (err) {
          // Download URLs live 5 minutes: get a fresh one once, then let pg-boss retry.
          if (!(err instanceof MediaDownloadError && err.kind === "url_expired")) throw err;
          log.info({ mediaFileId }, "media download URL expired, requesting a new one");
          info = await getInfo();
          downloaded = await deps.client.download(info.url, { maxBytes });
        }
      } catch (err) {
        if (err instanceof MediaDownloadError) {
          if (err.kind === "too_large") return finish("rejected", "too_large", err.message);
          if (err.kind === "not_found") return finish("failed", "media_not_found", err.message);
          if (err.kind === "host_not_allowed") {
            log.error({ mediaFileId }, "media download URL host not allowed (token not sent)");
            return finish("failed", "download_host_not_allowed", err.message);
          }
        }
        throw logIfUnauthorized(err, log);
      }

      const { bytes, sha256Hex } = downloaded;
      if (bytes.byteLength === 0) return finish("rejected", "empty_file");

      const declaredSha = info.sha256 ?? file.sha256;
      if (!sha256Matches(declaredSha, sha256Hex)) {
        // Corrupted/truncated transfer: retryable.
        throw new Error("media checksum mismatch (sha256 differs from Meta's)");
      }
      if (!contentMatchesMime(info.mimeType, bytes)) {
        return finish(
          "rejected",
          "content_mismatch",
          `content does not look like ${info.mimeType}`,
        );
      }

      await deps.storage.put(mediaFileId, bytes);
      await deps.repository.markStored(mediaFileId, {
        mimeType: info.mimeType,
        sizeBytes: bytes.byteLength,
        sha256: declaredSha,
        contentSha256: sha256Hex,
        storage: deps.storage.kind,
      });
      log.info(
        {
          mediaFileId,
          mimeType: info.mimeType,
          sizeBytes: bytes.byteLength,
          downloadMs: Date.now() - started,
        },
        "media stored",
      );

      if (deps.onMediaStored) {
        await deps.onMediaStored({ mediaFileId, mimeType: info.mimeType, kind: actual.kind, log });
      }
      return { outcome: "stored" };
    },
  };
}

function logIfUnauthorized(err: unknown, log: Logger): unknown {
  if (err instanceof MediaDownloadError && err.kind === "unauthorized") {
    log.error(
      { httpStatus: err.httpStatus },
      "WhatsApp access token invalid or expired: renew WHATSAPP_ACCESS_TOKEN (media download will retry)",
    );
  }
  return err;
}
