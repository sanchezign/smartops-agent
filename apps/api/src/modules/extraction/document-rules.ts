import type { ExtractionOutput } from "./extraction.schemas.js";

/**
 * Rules for extractions made from a CONVERTED document (pure, phase 5 M3a):
 * - An incomplete document (truncated by a limit, or with formulas without a calculated
 *   value) can never be a full list: products that were cut or empty would look missing
 *   and become "unavailable" candidates. It is downgraded to partial_update.
 * - The conversion warnings (hidden sheets skipped, encoding…) are added to the extraction
 *   warnings so the reviewer sees them.
 */

export interface ConvertedDocumentInfo {
  truncated: boolean;
  needsReview: boolean;
  warnings: { code: string; message: string }[];
}

export function applyDocumentRules(
  output: ExtractionOutput,
  document: ConvertedDocumentInfo | null,
): ExtractionOutput {
  if (!document) return output;
  const warnings = [...document.warnings.map((w) => `Documento: ${w.message}`), ...output.warnings];
  let { listKind, fullListEvidence } = output;
  if ((document.truncated || document.needsReview) && listKind === "full_list") {
    listKind = "partial_update";
    fullListEvidence = null;
    warnings.push(
      "Documento incompleto (truncado o con fórmulas sin valor): se trata como actualización parcial.",
    );
  }
  return { ...output, listKind, fullListEvidence, warnings: [...new Set(warnings)].slice(0, 30) };
}
