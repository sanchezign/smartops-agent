import { maskPhone, maskUserId } from "../../common/phone.js";
import type { ContactKind } from "../../generated/prisma/enums.js";
import { contactLockKey, type CatalogTx } from "./catalog.repository.js";
import { normalizeSupplierName } from "./supplier-name.js";

/**
 * Supplier of a contact (user rule, phase 5 M4), shared by the catalog ingest and the
 * approval of a spreadsheet format (M3c):
 * contact already linked → that supplier; else the document's supplierName matched
 * (normalized, legal forms ignored) with ONE existing supplier → link; no match → a new
 * supplier (supplierName, else the WhatsApp profile name, else "Proveedor <masked phone>")
 * linked to the contact. Several matches → ambiguous (a human decides).
 * Runs inside a catalog transaction, under the contact lock.
 */

export interface ContactForSupplier {
  id: string;
  name: string | null;
  waId: string | null;
  bsuid: string | null;
  kind: ContactKind;
}

export type SupplierResolution =
  | {
      status: "resolved";
      supplierId: string;
      created: boolean;
      linked: boolean;
      warnings: { code: "supplier_created" | "supplier_linked"; message: string }[];
    }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] };

export function fallbackSupplierName(contact: ContactForSupplier): string {
  if (contact.name?.trim()) return contact.name.trim();
  if (contact.waId) return `Proveedor ${maskPhone(contact.waId)}`;
  return `Proveedor ${maskUserId(contact.bsuid)}`;
}

export async function resolveSupplierInTx(
  tx: CatalogTx,
  contact: ContactForSupplier,
  supplierName: string | null,
): Promise<SupplierResolution> {
  await tx.lock(contactLockKey(contact.id));
  const current = await tx.contactSupplierId(contact.id);
  if (current)
    return { status: "resolved", supplierId: current, created: false, linked: false, warnings: [] };

  const warnings: Extract<SupplierResolution, { status: "resolved" }>["warnings"] = [];
  let supplierId: string | null = null;
  let created = false;
  if (supplierName) {
    const matches = await tx.suppliersByNormalizedName(normalizeSupplierName(supplierName));
    if (matches.length > 1) return { status: "ambiguous", candidates: matches };
    if (matches.length === 1) {
      supplierId = matches[0]!.id;
      warnings.push({
        code: "supplier_linked",
        message: `Contacto vinculado al proveedor existente "${matches[0]!.name}".`,
      });
    }
  }
  if (!supplierId) {
    const supplier = await tx.createSupplier(supplierName ?? fallbackSupplierName(contact));
    supplierId = supplier.id;
    created = true;
    warnings.push({
      code: "supplier_created",
      message: `Proveedor nuevo "${supplier.name}" creado y vinculado al contacto.`,
    });
  }
  await tx.linkContact(contact.id, supplierId, contact.kind);
  return { status: "resolved", supplierId, created, linked: true, warnings };
}
