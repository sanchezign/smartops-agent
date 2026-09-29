import { describe, expect, it } from "vitest";
import en from "../src/i18n/messages/en.json";
import es from "../src/i18n/messages/es.json";
import {
  LOCALE_COOKIE,
  localeCookie,
  localeFromAcceptLanguage,
  localeToApplyAfterLogin,
  resolveLocale,
} from "../src/i18n/locales";

/** Phase 13: which language the panel shows (cookie → PANEL_DEFAULT_LOCALE → browser → en). */

describe("Accept-Language", () => {
  it("picks the best of en / es by q-value, ties in header order", () => {
    expect(localeFromAcceptLanguage("es-UY,es;q=0.9,en;q=0.8")).toBe("es");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,es;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("pt-BR,es;q=0.5,en;q=0.7")).toBe("en");
    expect(localeFromAcceptLanguage("ES-ar")).toBe("es");
    expect(localeFromAcceptLanguage("en, es")).toBe("en");
    expect(localeFromAcceptLanguage("es;q=0.5, en;q=0.5")).toBe("es");
  });

  it("q=0 means not acceptable; unknown or empty → null", () => {
    expect(localeFromAcceptLanguage("es;q=0, en;q=0.1")).toBe("en");
    expect(localeFromAcceptLanguage("es;q=0")).toBeNull();
    expect(localeFromAcceptLanguage("pt-BR,fr")).toBeNull();
    expect(localeFromAcceptLanguage("*")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
    expect(localeFromAcceptLanguage("es;q=abc")).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("the person's choice (cookie) wins over everything", () => {
    expect(resolveLocale({ cookie: "es", configuredDefault: "en", acceptLanguage: "en" })).toBe(
      "es",
    );
  });

  it("PANEL_DEFAULT_LOCALE (public demo = en) wins over the browser", () => {
    expect(resolveLocale({ configuredDefault: "en", acceptLanguage: "es-UY,es" })).toBe("en");
  });

  it("outside the demo a Spanish browser sees Spanish; anything else English", () => {
    expect(resolveLocale({ acceptLanguage: "es-UY,es;q=0.9" })).toBe("es");
    expect(resolveLocale({ acceptLanguage: "fr-FR" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });

  it("invalid cookie / env values are ignored, never trusted", () => {
    expect(resolveLocale({ cookie: "fr", configuredDefault: "xx", acceptLanguage: "es" })).toBe(
      "es",
    );
    expect(resolveLocale({ cookie: "es; admin=1" })).toBe("en");
  });
});

describe("cookie and saved preference", () => {
  it("the cookie is a year-long, site-wide, Lax preference; Secure on https", () => {
    expect(localeCookie("es", true)).toBe(
      `${LOCALE_COOKIE}=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(localeCookie("en", false)).not.toContain("Secure");
  });

  it("after login only a DIFFERENT saved language is applied", () => {
    expect(localeToApplyAfterLogin("es", "en")).toBe("es");
    expect(localeToApplyAfterLogin("en", "en")).toBeNull();
    expect(localeToApplyAfterLogin(null, "en")).toBeNull();
    expect(localeToApplyAfterLogin(undefined, "es")).toBeNull();
    expect(localeToApplyAfterLogin("fr", "es")).toBeNull();
  });
});

describe("message catalogs", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];

  it("Spanish has exactly the English keys (no missing or stale ones)", () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
  });

  it("no empty message", () => {
    for (const catalog of [en, es]) {
      for (const key of keys(catalog)) {
        const value = key
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], catalog);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });
});
