import { formatPct } from "@/lib/format";
import type { ReviewItem, ReviewKind, ReviewScope, ReviewStatus } from "./types";

/** Plain-language texts for the review queue (phase 9 M2). */

export const SCOPE_LABEL: Record<ReviewScope, string> = {
  run: "Listas enteras",
  line: "Productos",
  catalog: "Catálogo",
};

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  superseded: "Reemplazada",
};

export const KIND_LABEL: Record<ReviewKind, string> = {
  product_match: "¿Es este producto?",
  new_or_existing: "¿Producto nuevo o existente?",
  possible_duplicate: "Posible duplicado",
  match_conflict: "Coincide con varios productos",
  uncertain_value: "Valor dudoso",
  pct_without_match: "Porcentaje sin producto",
  missing_currency: "Falta la moneda",
  currency_changed: "Cambió la moneda",
  price_outlier: "Cambio de precio fuera de lo normal",
  stale_source: "Mensaje más viejo que el precio actual",
  mark_unavailable: "¿Marcar como no disponible?",
  global_change: "Aumento general",
  tax_basis_changed: "Cambió el IVA de la lista",
  suspicious_instructions: "Mensaje sospechoso",
  unknown_supplier: "¿De qué proveedor es?",
  extraction_failed: "No se pudo leer",
  column_mapping: "Elegí la columna de precio",
};

/** One line explaining WHY a person has to look at it. */
export const KIND_HELP: Record<ReviewKind, string> = {
  product_match: "El nombre de la lista se parece a un producto del catálogo, pero no es seguro.",
  new_or_existing: "No sabemos si es un producto nuevo o uno que ya existe con otro nombre.",
  possible_duplicate: "Puede ser el mismo producto que otro del catálogo.",
  match_conflict: "La línea coincide con más de un producto del catálogo.",
  uncertain_value: "La IA no está segura del valor que leyó.",
  pct_without_match: "La lista da un porcentaje pero no encontramos a qué producto aplicarlo.",
  missing_currency: "La lista no dice la moneda y no se puede suponer.",
  currency_changed: "El proveedor cotiza este producto en otra moneda.",
  price_outlier: "El cambio supera el límite configurado en Reglas.",
  stale_source: "Este mensaje es anterior al precio que ya tenemos cargado.",
  mark_unavailable: "La lista completa no lo incluye, o el proveedor dice que no hay.",
  global_change: "El proveedor anunció un cambio para todos sus productos.",
  tax_basis_changed: "La lista pasó de precios con IVA a sin IVA (o al revés).",
  suspicious_instructions: "El mensaje intenta darle órdenes al sistema. No se aplicó nada.",
  unknown_supplier: "No pudimos saber con certeza de qué proveedor es la lista.",
  extraction_failed: "El archivo o el mensaje no se pudo procesar automáticamente.",
  column_mapping: "Es la primera vez que llega esta planilla: confirmá qué columna usar.",
};

const REASON_LABEL: Record<string, string> = {
  price_outlier: "Cambio fuera de lo normal",
  currency_changed: "Otra moneda",
  missing_currency: "Sin moneda",
  invalid_result: "Precio inválido",
  stale_source: "Mensaje viejo",
  pct_without_match: "Porcentaje sin producto",
  uncertain_value: "Valor dudoso",
  product_match: "Coincidencia dudosa",
  possible_duplicate: "Posible duplicado",
  new_or_existing: "¿Nuevo?",
  match_conflict: "Varias coincidencias",
  duplicate_line: "Línea repetida",
  auto_create_disabled: "Alta automática apagada",
  stated_unavailable_new: "Producto nuevo sin stock",
  suspicious_source: "Mensaje sospechoso",
  document_incomplete: "Documento incompleto",
  column_mapping_required: "Formato nuevo",
  sheet_format_changed: "Cambió el formato",
  suspicious_instructions: "Instrucciones sospechosas",
  missing_from_full_list: "No está en la lista completa",
  stated_unavailable: "El proveedor dice que no hay",
  global_change: "Cambio general",
  tax_basis_changed: "Cambio de IVA",
  unknown_supplier: "Proveedor dudoso",
  ambiguous_supplier_name: "Varios proveedores posibles",
};

export const reasonLabel = (reason: string) => REASON_LABEL[reason] ?? reason.replaceAll("_", " ");

/** Short description of the item for the list (what, not why). */
export function reviewTitle(item: ReviewItem): string {
  const proposal = (item.proposal ?? {}) as Record<string, unknown>;
  if (item.scope === "line") {
    const line = proposal.item as { name?: string } | undefined;
    return line?.name ?? item.product?.name ?? "Línea de la lista";
  }
  if (item.kind === "mark_unavailable") return item.product?.name ?? "Producto";
  if (item.kind === "global_change") {
    const pct = proposal.pct as string | undefined;
    const count = (proposal.products as unknown[] | undefined)?.length ?? 0;
    return `${pct ? formatPct(pct) : "Cambio"} a ${count} productos`;
  }
  if (item.message.media?.filename) return item.message.media.filename;
  return item.message.text ?? item.message.transcript ?? "Mensaje";
}
