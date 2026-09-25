import { z } from "zod";
import { currencyCode, priceString } from "../extraction/extraction.schemas.js";

/**
 * Inputs to resolve a review item (ADR-012). Used by the review service now and by the
 * panel routes in phase 9 (same schemas → same validation).
 */

export const approveReviewSchema = z
  .object({
    /** Line items: apply to this existing product (must belong to the supplier). */
    productId: z.uuid().optional(),
    /** Line items: create a new product instead. */
    createNew: z.boolean().optional(),
    /** Edited values (else the proposal's). */
    price: priceString.optional(),
    currency: currencyCode.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    /** unknown_supplier gate: link to this supplier, or create one with this name. */
    supplierId: z.uuid().optional(),
    createSupplier: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(500).optional(),
    /** column_mapping: per-table choices/corrections (the price column is REQUIRED when
     *  the table has several price columns). */
    tables: z
      .array(
        z
          .object({
            table: z.string().regex(/^T\d{1,3}$/),
            isPriceTable: z.boolean().optional(),
            headerRow: z.number().int().min(0).max(20).optional(),
            priceColumn: z.number().int().min(0).max(499).optional(),
            nameColumn: z.number().int().min(0).max(499).optional(),
            unitColumn: z.number().int().min(0).max(499).nullable().optional(),
            skuColumn: z.number().int().min(0).max(499).nullable().optional(),
            priceFormat: z.enum(["decimal_comma", "decimal_dot"]).optional(),
            currency: currencyCode.nullable().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .refine((v) => !(v.productId && v.createNew), {
    message: "productId and createNew are exclusive",
    path: ["createNew"],
  })
  .refine((v) => !(v.supplierId && v.createSupplier), {
    message: "supplierId and createSupplier are exclusive",
    path: ["createSupplier"],
  });
export type ApproveReviewInput = z.infer<typeof approveReviewSchema>;

export const rejectReviewSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
export type RejectReviewInput = z.infer<typeof rejectReviewSchema>;

/** Who resolves. Users arrive with admin auth (phase 8); until then "system" (tests, CLI). */
export interface ReviewActor {
  type: "user" | "system";
  userId?: string | null;
  requestId?: string | null;
}

/** Shape of ReviewItem.proposal for scope = line (written by catalog.repository.ts). */
export interface LineProposal {
  lineIndex: number;
  item: {
    name: string;
    sku: string | null;
    unit: string | null;
    price: string | null;
    priceChangePct: string | null;
    currency: string | null;
    available: boolean | null;
    stock: number | null;
  };
  listCurrency: string | null;
  messageAt: string;
  candidates: { id: string; name: string | null; price: string | null; currency: string | null }[];
  proposedPrice: string | null;
  currency: string | null;
  changePct: string | null;
}

export interface GlobalChangeProposal {
  pct: string;
  messageAt: string;
  products: {
    productId: string;
    name: string;
    oldPrice: string;
    newPrice: string;
    currency: string;
    changePct: string | null;
    outlier: boolean;
  }[];
}
