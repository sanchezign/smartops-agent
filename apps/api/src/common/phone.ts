/**
 * Masks a phone number / WhatsApp id for logs: keeps the first 3 and last 3
 * digits ("59899009160" → "598*****160"). Full values live only in the DB.
 * Non-digit characters are dropped; short or missing values are fully masked.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 6) return "*".repeat(Math.max(digits.length, 3));
  return `${digits.slice(0, 3)}${"*".repeat(digits.length - 6)}${digits.slice(-3)}`;
}

/** Masks every run of 8+ digits (optionally "+"-prefixed) inside free text, e.g. provider error details. */
export function maskPhonesInText(text: string): string {
  return text.replace(/\+?\d{8,}/g, (match) => maskPhone(match));
}
