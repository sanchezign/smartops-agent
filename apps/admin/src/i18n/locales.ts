/**
 * Panel languages (phase 13). Pure: shared by the server request config, the client switcher
 * and the tests. No i18n routing — the URL never carries the language.
 *
 * Resolution order (first match wins):
 *   1. the `smartops_locale` cookie (the person chose, or their saved preference at login)
 *   2. PANEL_DEFAULT_LOCALE (server env; the public demo sets "en")
 *   3. the browser's Accept-Language (es-* → es, en-* → en, by q-value)
 *   4. English
 */

export const LOCALES = ["en", "es"] as const;
export type AppLocale = (typeof LOCALES)[number];

export const FALLBACK_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "smartops_locale";
/** One year: a display preference, not a credential. */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Each language named in itself (the switcher shows them this way in both languages). */
export const LOCALE_NAMES: Record<AppLocale, string> = { en: "English", es: "Español" };

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "es";
}

/**
 * The best panel language for an Accept-Language header, or null when it names neither.
 * Honors q-values (q=0 = "not acceptable"); ties keep the header order.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): AppLocale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number(q);
      return {
        primary: tag.trim().toLowerCase().split("-")[0],
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((entry) => entry.primary).find(isAppLocale) ?? null;
}

export function resolveLocale(input: {
  cookie?: string | null;
  configuredDefault?: string | null;
  acceptLanguage?: string | null;
}): AppLocale {
  if (isAppLocale(input.cookie)) return input.cookie;
  if (isAppLocale(input.configuredDefault)) return input.configuredDefault;
  return localeFromAcceptLanguage(input.acceptLanguage) ?? FALLBACK_LOCALE;
}

/** The `document.cookie` assignment that stores the choice (readable by the server). */
export function localeCookie(locale: AppLocale, secure: boolean): string {
  return [
    `${LOCALE_COOKIE}=${locale}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * After a login: the language saved in the person's profile, when it differs from the one the
 * page is showing (null = nothing to change; an unsaved preference follows the browser).
 */
export function localeToApplyAfterLogin(
  saved: string | null | undefined,
  current: AppLocale,
): AppLocale | null {
  return isAppLocale(saved) && saved !== current ? saved : null;
}
