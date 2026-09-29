import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { serverEnv } from "@/env";
import { TIME_ZONE } from "@/lib/format";
import { LOCALE_COOKIE, resolveLocale } from "./locales";

/**
 * next-intl request config (phase 13, App Router WITHOUT i18n routing): the language is
 * resolved per request from the cookie → PANEL_DEFAULT_LOCALE → Accept-Language → English
 * (see locales.ts). Dates always use the business time zone.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    configuredDefault: serverEnv().PANEL_DEFAULT_LOCALE,
    acceptLanguage: headerStore.get("accept-language"),
  });
  return {
    locale,
    timeZone: TIME_ZONE,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
