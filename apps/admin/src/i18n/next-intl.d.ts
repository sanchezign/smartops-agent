import type en from "./messages/en.json";
import type { AppLocale } from "./locales";

/** Typed message keys and locales (phase 13): English is the source catalog. */
declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof en;
  }
}
