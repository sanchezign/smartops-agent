-- CreateEnum
CREATE TYPE "TranscriptionStatus" AS ENUM ('pending', 'done', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "transcriptions" (
    "id" UUID NOT NULL,
    "media_file_id" UUID NOT NULL,
    "status" "TranscriptionStatus" NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "model" TEXT,
    "language" TEXT,
    "text" TEXT,
    "duration_seconds" DECIMAL(10,2),
    "latency_ms" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "error" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transcriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcriptions_media_file_id_key" ON "transcriptions"("media_file_id");

-- CreateIndex
CREATE INDEX "transcriptions_status_created_at_idx" ON "transcriptions"("status", "created_at");

-- AddForeignKey
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
