-- CreateEnum
CREATE TYPE "DocumentConversionStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "document_conversions" (
    "id" UUID NOT NULL,
    "media_file_id" UUID NOT NULL,
    "status" "DocumentConversionStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "format" TEXT,
    "text" TEXT,
    "char_count" INTEGER,
    "data_rows" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "sheets" JSONB,
    "warnings" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "converter_version" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_conversions_media_file_id_key" ON "document_conversions"("media_file_id");

-- CreateIndex
CREATE INDEX "document_conversions_status_created_at_idx" ON "document_conversions"("status", "created_at");

-- AddForeignKey
ALTER TABLE "document_conversions" ADD CONSTRAINT "document_conversions_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

