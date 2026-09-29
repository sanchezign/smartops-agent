import type { Metadata } from "next";
import type { Messages } from "next-intl";
import { getTranslations } from "next-intl/server";

type PageKey = keyof Messages["pages"];

/** `export const generateMetadata = pageMetadata("alerts")` — the page title in the panel language. */
export function pageMetadata(key: PageKey, extra: Metadata = {}) {
  return async (): Promise<Metadata> => {
    const t = await getTranslations("pages");
    return { title: t(key), ...extra };
  };
}
