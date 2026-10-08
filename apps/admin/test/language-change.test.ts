import { describe, expect, it } from "vitest";
import { BUSINESS_LANGUAGE_KEY, languageChange } from "@/features/rules/language-change";

describe("business language change (ADR-031)", () => {
  it("asks for confirmation only when the business language really changes", () => {
    expect(languageChange([[BUSINESS_LANGUAGE_KEY, "en"]], "es")).toEqual({ from: "es", to: "en" });
    expect(languageChange([[BUSINESS_LANGUAGE_KEY, "es"]], "en")).toEqual({ from: "en", to: "es" });
    // a language never saved (the default) counts as "unknown": still a change
    expect(languageChange([[BUSINESS_LANGUAGE_KEY, "en"]], undefined)).toEqual({
      from: null,
      to: "en",
    });
  });

  it("does not ask when it did not change, or when the language is not among the changes", () => {
    expect(languageChange([[BUSINESS_LANGUAGE_KEY, "es"]], "es")).toBeNull();
    expect(languageChange([["bot.supplierAck", true]], "es")).toBeNull();
    expect(languageChange([], "es")).toBeNull();
    expect(languageChange([[BUSINESS_LANGUAGE_KEY, 5]], "es")).toBeNull();
  });

  it("finds it among other changes of the same section", () => {
    expect(
      languageChange(
        [
          ["bot.supplierAck", false],
          [BUSINESS_LANGUAGE_KEY, "en"],
        ],
        "es",
      ),
    ).toEqual({ from: "es", to: "en" });
  });
});
