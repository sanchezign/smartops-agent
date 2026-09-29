import { describe, expect, it } from "vitest";
import {
  BUSINESS_LANGUAGES,
  businessMoney,
  businessPct,
  businessTexts,
  toBusinessLanguage,
} from "../../src/common/business-texts.js";
import { alertDetails } from "../../src/modules/admin/alert-details.js";
import { detectComplianceEvent } from "../../src/modules/optout/optout-detector.js";
import { SETTING_DEFINITIONS } from "../../src/modules/settings/settings.schemas.js";

/** WhatsApp texts in the business language (phase 13). */

const defaults = {
  optOut: SETTING_DEFINITIONS["optOut.keywords"].default,
  optIn: SETTING_DEFINITIONS["optIn.keywords"].default,
};

describe("business language", () => {
  it("defaults to Spanish; only es / en are accepted", () => {
    expect(SETTING_DEFINITIONS["business.language"].default).toBe("es");
    expect(SETTING_DEFINITIONS["business.language"].schema.safeParse("fr").success).toBe(false);
    expect(toBusinessLanguage("en")).toBe("en");
    expect(toBusinessLanguage(undefined)).toBe("es");
    expect(toBusinessLanguage("xx")).toBe("es");
  });

  it.each(BUSINESS_LANGUAGES)(
    "%s: the keywords the texts tell people to send really opt them out / back in",
    (language) => {
      const texts = businessTexts(language);
      expect(texts.optOutInstruction).toContain(texts.optOutKeyword);
      expect(texts.optOutConfirmation).toContain(texts.optInKeyword);
      expect(detectComplianceEvent(texts.optOutKeyword, defaults)?.kind).toBe("opt_out");
      expect(detectComplianceEvent(texts.optInKeyword, defaults)?.kind).toBe("opt_in");
    },
  );

  it("Spanish messages to contacts use 'usted', never voseo or 'tú'", () => {
    const es = businessTexts("es");
    const contactTexts = [
      es.optOutInstruction,
      es.optOutConfirmation,
      es.optInConfirmation,
      es.ack.underReview,
      es.ack.listWith(["2 precios actualizados"]),
      es.ack.listNoChanges,
    ].join(" ");
    expect(contactTexts).not.toMatch(
      /\b(respondé|querés|vas a|tu lista|te confirmamos|responde ALTA|desees)\b/i,
    );
    expect(contactTexts).toMatch(/Responda BAJA/);
    expect(contactTexts).toMatch(/su lista/);
  });

  it("money keeps '$' for the business currency and 'US$' for dollars in both languages", () => {
    expect(businessMoney("es", "1850", "UYU")).toBe("$ 1.850,00");
    expect(businessMoney("en", "1850", "UYU")).toBe("$1,850.00");
    expect(businessMoney("es", "72", "USD")).toBe("US$ 72,00");
    expect(businessMoney("en", "72", "USD")).toBe("US$72.00");
    expect(businessMoney("en", "10", "ARS")).toBe("ARS 10.00");
    expect(businessPct("es", "16.6667")).toBe("+16,7 %");
    expect(businessPct("en", "-7.54")).toBe("−7.5%");
  });
});

describe("alertDetails (what the panel may read from an alert payload)", () => {
  it("whitelists the fields of each type and drops everything else", () => {
    expect(
      alertDetails("price_change", {
        oldPrice: "12",
        newPrice: "14",
        currency: "UYU",
        changePct: "16.67",
        secret: "x",
      }),
    ).toEqual({ oldPrice: "12", newPrice: "14", currency: "UYU", changePct: "16.67" });
    expect(
      alertDetails("possible_opt_out", { contactId: "c", messageId: "m", matched: "no más" }),
    ).toEqual({ matched: "no más" });
    expect(
      alertDetails("manual_attention", {
        reason: "audio_too_long",
        mediaFileId: "f",
        durationSeconds: 252,
        sizeBytes: 1,
        maxSeconds: 180,
      }),
    ).toEqual({ reason: "audio_too_long", durationSeconds: 252, sizeBytes: 1, maxSeconds: 180 });
  });

  it("unknown types, empty or odd payloads → null (the panel falls back to the title)", () => {
    expect(alertDetails("missing_data", { a: 1 })).toBeNull();
    expect(alertDetails("low_stock", null)).toBeNull();
    expect(alertDetails("low_stock", ["x"])).toBeNull();
    expect(alertDetails("low_stock", { stock: { nested: 1 } })).toBeNull();
    expect(alertDetails("low_stock", { stock: 3 })).toEqual({ stock: 3 });
  });
});
