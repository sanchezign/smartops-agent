import type { BusinessLanguage } from "../../common/business-texts.js";

/**
 * What the extraction rules write into warnings and notes (phase 14 M5b, ADR-031): a reviewer
 * reads them in the business language. "es" is exactly what these rules always said
 * (test/unit/heuristics-es-identical.test.ts compares with a frozen copy of the old code).
 */
export interface RuleTexts {
  fullListWithoutEvidence: string;
  unknownCatalogRef(name: string, ref: string): string;
  sameCatalogProduct: string;
  missingAttributes(name: string, missing: string[], catalogName: string): string;
  documentPrefix(message: string): string;
  incompleteDocument: string;
}

export const RULE_TEXTS: Record<BusinessLanguage, RuleTexts> = {
  es: {
    fullListWithoutEvidence:
      "Se indicó lista completa sin evidencia explícita en el documento: se trata como actualización parcial.",
    unknownCatalogRef: (name, ref) =>
      `"${name}": referencia de catálogo desconocida (${ref}), se ignora.`,
    sameCatalogProduct: "Varias líneas apuntan al mismo producto del catálogo.",
    missingAttributes: (name, missing, catalogName) =>
      `"${name}" no indica ${missing.join(", ")} de "${catalogName}": requiere revisión.`,
    documentPrefix: (message) => `Documento: ${message}`,
    incompleteDocument:
      "Documento incompleto (truncado o con fórmulas sin valor): se trata como actualización parcial.",
  },
  en: {
    fullListWithoutEvidence:
      "A full list was declared without explicit evidence in the document: treated as a partial update.",
    unknownCatalogRef: (name, ref) => `"${name}": unknown catalog reference (${ref}), ignored.`,
    sameCatalogProduct: "Several lines point to the same catalog product.",
    missingAttributes: (name, missing, catalogName) =>
      `"${name}" does not state ${missing.join(", ")} of "${catalogName}": needs review.`,
    documentPrefix: (message) => `Document: ${message}`,
    incompleteDocument:
      "Incomplete document (truncated or with formulas without a value): treated as a partial update.",
  },
};
