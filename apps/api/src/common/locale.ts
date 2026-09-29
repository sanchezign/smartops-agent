/**
 * Languages of the panel (phase 13). English is the default; Spanish is neutral Latin American
 * Spanish. The same codes name the business language of WhatsApp messages.
 */
export const APP_LOCALES = ["en", "es"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export function toAppLocale(value: string | null | undefined): AppLocale | null {
  return value === "en" || value === "es" ? value : null;
}
