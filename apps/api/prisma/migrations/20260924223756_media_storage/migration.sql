-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('pending', 'stored', 'skipped', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "MediaStorageKind" AS ENUM ('postgres');

-- AlterTable
ALTER TABLE "media_files" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "content_sha256" CHAR(64),
ADD COLUMN     "downloaded_at" TIMESTAMPTZ(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "reject_reason" TEXT,
ADD COLUMN     "status" "MediaStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "storage" "MediaStorageKind";

-- CreateTable
CREATE TABLE "media_blobs" (
    "media_file_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_blobs_pkey" PRIMARY KEY ("media_file_id")
);

-- CreateIndex
CREATE INDEX "media_files_status_created_at_idx" ON "media_files"("status", "created_at");

-- AddForeignKey
ALTER TABLE "media_blobs" ADD CONSTRAINT "media_blobs_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ADR-008: media bytes are already compressed (PDF/JPEG/OGG); skip TOAST compression
-- but keep out-of-line storage. Prisma does not model this; keep it when editing MediaBlob.
ALTER TABLE "media_blobs" ALTER COLUMN "data" SET STORAGE EXTERNAL;
