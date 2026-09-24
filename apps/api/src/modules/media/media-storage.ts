import type { PrismaClient } from "../../common/db.js";
import type { MediaStorageKind } from "../../generated/prisma/enums.js";

/**
 * Where media bytes live (ADR-008). Features only use this interface, so moving to an
 * S3-compatible bucket means adding another implementation + a backfill, nothing else.
 */
export interface MediaStorage {
  readonly kind: MediaStorageKind;
  /** Idempotent: storing the same media twice overwrites the bytes. */
  put(mediaFileId: string, bytes: Uint8Array): Promise<void>;
  get(mediaFileId: string): Promise<Uint8Array | null>;
}

/** Postgres bytea in `media_blobs` (one row per MediaFile). */
export function createPostgresMediaStorage(prisma: PrismaClient): MediaStorage {
  return {
    kind: "postgres",

    async put(mediaFileId, bytes) {
      // Prisma 7 maps Bytes to Uint8Array<ArrayBuffer>; copy into a fresh buffer.
      const data = new Uint8Array(bytes);
      await prisma.mediaBlob.upsert({
        where: { mediaFileId },
        create: { mediaFileId, data },
        update: { data },
      });
    },

    async get(mediaFileId) {
      const blob = await prisma.mediaBlob.findUnique({
        where: { mediaFileId },
        select: { data: true },
      });
      return blob?.data ?? null;
    },
  };
}
