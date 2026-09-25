-- CreateEnum
CREATE TYPE "AiTask" AS ENUM ('classify', 'extract');

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('ok', 'error', 'budget_blocked');

-- AlterTable
ALTER TABLE "ingestion_runs" ADD COLUMN     "cache_read_tokens" INTEGER,
ADD COLUMN     "cache_write_tokens" INTEGER,
ADD COLUMN     "cost_usd" DECIMAL(12,6),
ADD COLUMN     "prompt_version" TEXT;

-- CreateTable
CREATE TABLE "ai_usages" (
    "id" UUID NOT NULL,
    "task" "AiTask" NOT NULL,
    "status" "AiUsageStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "prompt_version" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "ingestion_run_id" UUID,
    "message_id" UUID,
    "contact_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usages_created_at_idx" ON "ai_usages"("created_at");

-- CreateIndex
CREATE INDEX "ai_usages_contact_id_task_created_at_idx" ON "ai_usages"("contact_id", "task", "created_at");

-- CreateIndex
CREATE INDEX "ai_usages_ingestion_run_id_idx" ON "ai_usages"("ingestion_run_id");

-- AddForeignKey
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
