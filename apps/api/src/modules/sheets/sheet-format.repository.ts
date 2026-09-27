import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SheetMapping } from "./sheet-mapping.js";

/**
 * Remembered spreadsheet formats per supplier (phase 5 M3c, ADR-014). Several formats can be
 * active per supplier (different spreadsheets), one per header fingerprint. A format that
 * fails validation is RETIRED (never deleted) and the table is mapped again.
 */

/** Stored mapping: non-price tables (notes, conditions) are remembered too. */
export type StoredSheetFormat =
  { isPriceTable: true; mapping: SheetMapping } | { isPriceTable: false; mapping: null };

export interface ActiveSheetFormat {
  id: string;
  fingerprint: string;
  sheetName: string | null;
  format: StoredSheetFormat;
}

export interface SheetFormatRepository {
  active(supplierId: string): Promise<ActiveSheetFormat[]>;
  retire(id: string, reason: string): Promise<void>;
  markUsed(ids: string[]): Promise<void>;
}

export interface SaveSheetFormatInput {
  supplierId: string;
  fingerprint: string;
  headerCells: string[];
  sheetName: string | null;
  format: StoredSheetFormat;
  approvedById: string | null;
  /** The column_mapping review that approved it (null: seeded demo format). */
  reviewItemId: string | null;
}

/**
 * Saves an approved format inside the caller's transaction. An active format with the same
 * (supplier, fingerprint) is retired first (partial unique index: one active per pair).
 */
export async function saveSheetFormatInTx(
  tx: Prisma.TransactionClient,
  input: SaveSheetFormatInput,
): Promise<string> {
  await tx.supplierSheetFormat.updateMany({
    where: { supplierId: input.supplierId, fingerprint: input.fingerprint, status: "active" },
    data: { status: "retired", retiredAt: new Date(), retiredReason: "replaced" },
  });
  const row = await tx.supplierSheetFormat.create({
    data: {
      supplierId: input.supplierId,
      fingerprint: input.fingerprint,
      headerCells: input.headerCells,
      sheetName: input.sheetName,
      mapping: input.format as unknown as Prisma.InputJsonValue,
      approvedById: input.approvedById,
      reviewItemId: input.reviewItemId,
    },
    select: { id: true },
  });
  return row.id;
}

export function createSheetFormatRepository(prisma: PrismaClient): SheetFormatRepository {
  return {
    async active(supplierId) {
      const rows = await prisma.supplierSheetFormat.findMany({
        where: { supplierId, status: "active" },
        select: { id: true, fingerprint: true, sheetName: true, mapping: true },
        orderBy: { approvedAt: "asc" },
      });
      return rows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        sheetName: r.sheetName,
        format: r.mapping as unknown as StoredSheetFormat,
      }));
    },

    async retire(id, reason) {
      await prisma.supplierSheetFormat.updateMany({
        where: { id, status: "active" },
        data: { status: "retired", retiredAt: new Date(), retiredReason: reason },
      });
    },

    async markUsed(ids) {
      if (ids.length === 0) return;
      await prisma.supplierSheetFormat.updateMany({
        where: { id: { in: ids } },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      });
    },
  };
}
