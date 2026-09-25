-- CreateEnum
CREATE TYPE "ReviewScope" AS ENUM ('run', 'line', 'catalog');

-- CreateEnum
CREATE TYPE "ReviewKind" AS ENUM ('product_match', 'new_or_existing', 'possible_duplicate', 'match_conflict', 'uncertain_value', 'pct_without_match', 'missing_currency', 'currency_changed', 'price_outlier', 'stale_source', 'mark_unavailable', 'global_change', 'tax_basis_changed', 'suspicious_instructions', 'unknown_supplier', 'extraction_failed');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'approved', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "PriceChangeSource" AS ENUM ('auto', 'review');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IngestionStatus" ADD VALUE 'ingesting';
ALTER TYPE "IngestionStatus" ADD VALUE 'rejected';

-- AlterTable
ALTER TABLE "price_changes" ADD COLUMN     "review_item_id" UUID,
ADD COLUMN     "source" "PriceChangeSource" NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "price_source_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "normalized_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tax_included" BOOLEAN,
ADD COLUMN     "tax_included_at" TIMESTAMPTZ(3);

-- Backfill (approximation of normalizeSupplierName; the app keeps it exact from now on)
UPDATE "suppliers" SET "normalized_name" = lower(trim(regexp_replace("name", '[^[:alnum:]]+', ' ', 'g')));
ALTER TABLE "suppliers" ALTER COLUMN "normalized_name" DROP DEFAULT;

-- CreateTable
CREATE TABLE "review_items" (
    "id" UUID NOT NULL,
    "ingestion_run_id" UUID NOT NULL,
    "supplier_id" UUID,
    "product_id" UUID,
    "scope" "ReviewScope" NOT NULL,
    "kind" "ReviewKind" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "dedupe_key" TEXT NOT NULL,
    "reasons" TEXT[],
    "proposal" JSONB NOT NULL,
    "base_price" DECIMAL(18,4),
    "base_currency" CHAR(3),
    "resolution" JSONB,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_items_status_created_at_idx" ON "review_items"("status", "created_at");

-- CreateIndex
CREATE INDEX "review_items_supplier_id_status_idx" ON "review_items"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "review_items_product_id_status_idx" ON "review_items"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_items_ingestion_run_id_dedupe_key_key" ON "review_items"("ingestion_run_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "price_changes_review_item_id_idx" ON "price_changes"("review_item_id");

-- CreateIndex
CREATE INDEX "suppliers_normalized_name_idx" ON "suppliers"("normalized_name");

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_review_item_id_fkey" FOREIGN KEY ("review_item_id") REFERENCES "review_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A run never applies two automatic changes to the same product (idempotent ingest).
-- Prisma does not model partial indexes: keep this when editing PriceChange.
CREATE UNIQUE INDEX "price_changes_run_product_auto_key" ON "price_changes"("ingestion_run_id", "product_id") WHERE "source" = 'auto' AND "ingestion_run_id" IS NOT NULL;
