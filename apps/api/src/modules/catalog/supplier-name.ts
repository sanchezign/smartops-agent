/**
 * Supplier name normalization for matching a document's supplier name with existing
 * suppliers (pure): accents, case, punctuation and trailing legal forms are ignored.
 * "Distribuidora Demo S.A." = "DISTRIBUIDORA DEMO SA" = "Distribuidora Demo".
 */

const LEGAL_FORMS = [
  "sociedad anonima",
  "s a s",
  "s r l",
  "s a",
  "sas",
  "srl",
  "sa",
  "ltda",
  "ltd",
  "inc",
  "llc",
];

export function normalizeSupplierName(name: string): string {
  let normalized = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      if (normalized.endsWith(` ${form}`)) {
        normalized = normalized.slice(0, -form.length - 1).trim();
        changed = true;
      }
    }
  }
  return normalized;
}
