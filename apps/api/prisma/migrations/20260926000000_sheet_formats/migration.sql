-- CreateEnum
CREATE TYPE "SheetFormatStatus" AS ENUM ('active', 'retired');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiTask" ADD VALUE 'map_columns';
ALTER TYPE "AiTask" ADD VALUE 'match';

-- AlterEnum
ALTER TYPE "ReviewKind" ADD VALUE 'column_mapping';

-- AlterTable
ALTER TABLE "document_conversions" ADD COLUMN     "tables" JSONB;

-- CreateTable
CREATE TABLE "supplier_sheet_formats" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "header_cells" JSONB NOT NULL,
    "sheet_name" TEXT,
    "mapping" JSONB NOT NULL,
    "status" "SheetFormatStatus" NOT NULL DEFAULT 'active',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_item_id" UUID,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "retired_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_sheet_formats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_sheet_formats_supplier_id_fingerprint_idx" ON "supplier_sheet_formats"("supplier_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "supplier_sheet_formats" ADD CONSTRAINT "supplier_sheet_formats_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sheet_formats" ADD CONSTRAINT "supplier_sheet_formats_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one ACTIVE format per (supplier, header fingerprint); retired ones are kept.
-- Prisma does not model partial indexes: keep this when editing SupplierSheetFormat.
CREATE UNIQUE INDEX "supplier_sheet_formats_active_key" ON "supplier_sheet_formats"("supplier_id", "fingerprint") WHERE "status" = 'active';
