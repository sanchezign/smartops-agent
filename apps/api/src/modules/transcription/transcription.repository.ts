import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { MediaStatus, TranscriptionStatus } from "../../generated/prisma/enums.js";
import type { MediaKind } from "../media/media-policy.js";
import type { OnMediaStoredInTx } from "../media/media.repository.js";

/** Transcriptions. The only place in the transcription flow that touches Prisma. */

export interface TranscriptionForProcessing {
  mediaFileId: string;
  status: TranscriptionStatus;
  mimeType: string;
  mediaStatus: MediaStatus;
  messageId: string | null;
  contactId: string | null;
}

export interface TranscriptionRepository {
  getForProcessing(mediaFileId: string): Promise<TranscriptionForProcessing | null>;
  incrementAttempts(mediaFileId: string): Promise<void>;
  /** Transcriptions completed for a contact since `since` (daily quota). */
  countDoneForContactSince(contactId: string, since: Date): Promise<number>;
  /** pending → done; copies the text to Message.transcript in the same transaction. */
  markDone(
    mediaFileId: string,
    input: {
      text: string;
      provider: string;
      model: string;
      language: string | null;
      durationSeconds: number | null;
      latencyMs: number;
    },
  ): Promise<void>;
  /** pending → skipped | failed (no-op otherwise). */
  markFinal(
    mediaFileId: string,
    status: "skipped" | "failed",
    reason: string,
    error?: string,
  ): Promise<void>;
  recordError(mediaFileId: string, error: string): Promise<void>;
  /** failed → pending for a manual retry. Returns the media file ids reset. */
  resetFailed(options: { mediaFileIds?: string[]; limit: number }): Promise<string[]>;
}

const truncate = (value: string) => (value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value);

/** Creates the pending transcription row (idempotent) inside the caller's transaction. */
export async function createPendingTranscriptionInTx(
  tx: Prisma.TransactionClient,
  mediaFileId: string,
): Promise<void> {
  await tx.transcription.upsert({
    where: { mediaFileId },
    create: { mediaFileId },
    update: {},
  });
}

/**
 * Media-stored hook for audio: pending transcription row + job, in the same
 * transaction that marks the media stored (atomic, like M3/M4).
 */
export function createOnAudioStoredInTx(deps: {
  enqueueTranscriptionInTx: (tx: Prisma.TransactionClient, mediaFileId: string) => Promise<void>;
}): OnMediaStoredInTx {
  return async (tx, media: { mediaFileId: string; kind: MediaKind }) => {
    if (media.kind !== "audio") return;
    await createPendingTranscriptionInTx(tx, media.mediaFileId);
    await deps.enqueueTranscriptionInTx(tx, media.mediaFileId);
  };
}

export function createTranscriptionRepository(prisma: PrismaClient): TranscriptionRepository {
  return {
    async getForProcessing(mediaFileId) {
      const row = await prisma.transcription.findUnique({
        where: { mediaFileId },
        select: {
          mediaFileId: true,
          status: true,
          mediaFile: {
            select: {
              mimeType: true,
              status: true,
              message: {
                select: { id: true, conversation: { select: { contactId: true } } },
              },
            },
          },
        },
      });
      if (!row) return null;
      return {
        mediaFileId: row.mediaFileId,
        status: row.status,
        mimeType: row.mediaFile.mimeType,
        mediaStatus: row.mediaFile.status,
        messageId: row.mediaFile.message?.id ?? null,
        contactId: row.mediaFile.message?.conversation.contactId ?? null,
      };
    },

    async incrementAttempts(mediaFileId) {
      await prisma.transcription.update({
        where: { mediaFileId },
        data: { attempts: { increment: 1 } },
      });
    },

    async countDoneForContactSince(contactId, since) {
      return prisma.transcription.count({
        where: {
          status: "done",
          completedAt: { gte: since },
          mediaFile: { message: { conversation: { contactId } } },
        },
      });
    },

    async markDone(mediaFileId, input) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.transcription.updateMany({
          where: { mediaFileId, status: "pending" },
          data: {
            status: "done",
            text: input.text,
            provider: input.provider,
            model: input.model,
            language: input.language,
            durationSeconds: input.durationSeconds,
            latencyMs: input.latencyMs,
            completedAt: new Date(),
            reason: input.text.length === 0 ? "empty_transcript" : null,
            error: null,
          },
        });
        if (updated.count === 1) {
          await tx.message.updateMany({
            where: { mediaFileId },
            data: { transcript: input.text },
          });
        }
      });
    },

    async markFinal(mediaFileId, status, reason, error) {
      await prisma.transcription.updateMany({
        where: { mediaFileId, status: "pending" },
        data: {
          status,
          reason,
          completedAt: new Date(),
          ...(error ? { error: truncate(error) } : {}),
        },
      });
    },

    async recordError(mediaFileId, error) {
      await prisma.transcription.update({
        where: { mediaFileId },
        data: { error: truncate(error) },
      });
    },

    async resetFailed({ mediaFileIds, limit }) {
      const rows = await prisma.transcription.findMany({
        where: { status: "failed", ...(mediaFileIds ? { mediaFileId: { in: mediaFileIds } } : {}) },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { mediaFileId: true },
      });
      const ids = rows.map((r) => r.mediaFileId);
      if (ids.length > 0) {
        await prisma.transcription.updateMany({
          where: { mediaFileId: { in: ids }, status: "failed" },
          data: { status: "pending", reason: null, error: null, attempts: 0, completedAt: null },
        });
      }
      return ids;
    },
  };
}
