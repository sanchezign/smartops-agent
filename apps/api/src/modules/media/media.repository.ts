import type { PrismaClient } from "../../common/db.js";
import type { EmitMessageReadyInTx } from "../integration/message-ready.js";
import { documentFormat } from "../documents/document-types.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { MediaStatus, MediaStorageKind } from "../../generated/prisma/enums.js";
import type { MediaKind } from "./media-policy.js";

/** Media download state. The only place in the media flow that touches Prisma. */

export interface MediaFileForDownload {
  id: string;
  waMediaId: string;
  mimeType: string;
  sha256: string | null;
  status: MediaStatus;
  /** WhatsApp message type (image | audio | document | …), null if orphaned. */
  messageType: string | null;
}

/**
 * Runs INSIDE the transaction that marks the media stored (e.g. phase 4: create the
 * pending transcription + enqueue its job for audio). Throwing rolls everything back.
 */
export type OnMediaStoredInTx = (
  tx: Prisma.TransactionClient,
  media: { mediaFileId: string; kind: MediaKind; mimeType: string },
) => Promise<void>;

/**
 * Stored media that needs no more work (images, PDFs) makes its message ready. Audio waits
 * for the transcription, convertible documents for the conversion (their own hooks).
 */
export function createOnReadyMediaStoredInTx(emit: EmitMessageReadyInTx): OnMediaStoredInTx {
  return async (tx, media) => {
    const needsMoreWork =
      media.kind === "audio" ||
      (media.kind === "document" && documentFormat(media.mimeType, null) !== null);
    if (!needsMoreWork) await emit(tx, { mediaFileId: media.mediaFileId });
  };
}

/** Runs several media-stored hooks in order, inside the same transaction. */
export function composeOnStoredInTx(...hooks: OnMediaStoredInTx[]): OnMediaStoredInTx {
  return async (tx, media) => {
    for (const hook of hooks) await hook(tx, media);
  };
}

export interface MediaRepository {
  getForDownload(id: string): Promise<MediaFileForDownload | null>;
  incrementAttempts(id: string): Promise<void>;
  /** pending → stored (no-op if no longer pending). */
  markStored(
    id: string,
    input: {
      mimeType: string;
      sizeBytes: number;
      sha256: string | null;
      contentSha256: string;
      storage: MediaStorageKind;
      kind: MediaKind;
    },
  ): Promise<void>;
  /** pending → rejected | skipped | failed (no-op if no longer pending). */
  markFinal(
    id: string,
    status: "rejected" | "skipped" | "failed",
    reason: string,
    error?: string,
  ): Promise<void>;
  recordError(id: string, error: string): Promise<void>;
  /** failed → pending for a manual retry. Returns the ids reset. */
  resetFailed(options: { ids?: string[]; limit: number }): Promise<string[]>;
}

const MAX_ERROR_LENGTH = 2_000;
const truncate = (value: string) =>
  value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH)}…` : value;

export function createMediaRepository(
  prisma: PrismaClient,
  deps: {
    onStoredInTx: OnMediaStoredInTx;
    /** Outbox "message.ready" (phase 6): media rejected / failed / skipped for good. */
    emitMessageReadyInTx?: EmitMessageReadyInTx;
  },
): MediaRepository {
  return {
    async getForDownload(id) {
      const row = await prisma.mediaFile.findUnique({
        where: { id },
        select: {
          id: true,
          waMediaId: true,
          mimeType: true,
          sha256: true,
          status: true,
          message: { select: { type: true } },
        },
      });
      if (!row) return null;
      const { message, ...rest } = row;
      return { ...rest, messageType: message?.type ?? null };
    },

    async incrementAttempts(id) {
      await prisma.mediaFile.update({ where: { id }, data: { attempts: { increment: 1 } } });
    },

    async markStored(id, input) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.mediaFile.updateMany({
          where: { id, status: "pending" },
          data: {
            status: "stored",
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            contentSha256: input.contentSha256,
            storage: input.storage,
            downloadedAt: new Date(),
            rejectReason: null,
            error: null,
          },
        });
        // Only the transition pending → stored triggers follow-up work (idempotent).
        if (updated.count === 1) {
          await deps.onStoredInTx(tx, {
            mediaFileId: id,
            kind: input.kind,
            mimeType: input.mimeType,
          });
        }
      });
    },

    async markFinal(id, status, reason, error) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.mediaFile.updateMany({
          where: { id, status: "pending" },
          data: { status, rejectReason: reason, ...(error ? { error: truncate(error) } : {}) },
        });
        if (updated.count === 1 && deps.emitMessageReadyInTx) {
          await deps.emitMessageReadyInTx(tx, { mediaFileId: id });
        }
      });
    },

    async recordError(id, error) {
      await prisma.mediaFile.update({ where: { id }, data: { error: truncate(error) } });
    },

    async resetFailed({ ids, limit }) {
      const rows = await prisma.mediaFile.findMany({
        where: { status: "failed", ...(ids ? { id: { in: ids } } : {}) },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true },
      });
      const toReset = rows.map((r) => r.id);
      if (toReset.length > 0) {
        await prisma.mediaFile.updateMany({
          where: { id: { in: toReset }, status: "failed" },
          data: { status: "pending", rejectReason: null, error: null, attempts: 0 },
        });
      }
      return toReset;
    },
  };
}
