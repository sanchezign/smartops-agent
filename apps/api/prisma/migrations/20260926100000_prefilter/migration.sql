-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'manual_attention';

-- AlterTable
ALTER TABLE "ingestion_runs" ADD COLUMN     "prefilter_rule" TEXT;

-- CreateIndex
CREATE INDEX "ingestion_runs_prefilter_rule_created_at_idx" ON "ingestion_runs"("prefilter_rule", "created_at");

