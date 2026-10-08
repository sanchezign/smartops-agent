import { describe, expect, it } from "vitest";
import { statusTone, supplierSuffix, whoAnswers } from "../src/features/conversations/labels";

/** Conversation labels (phase 9 M3). */

describe("whoAnswers", () => {
  it("an opted-out contact wins over the mode (the bot sends it nothing)", () => {
    expect(whoAnswers({ mode: "bot", contact: { optOutAt: null } })).toBe("bot");
    expect(whoAnswers({ mode: "human", contact: { optOutAt: null } })).toBe("human");
    expect(whoAnswers({ mode: "human", contact: { optOutAt: "2026-09-27T10:00:00Z" } })).toBe(
      "opted_out",
    );
  });
});

describe("supplierSuffix", () => {
  const supplier = (name: string) => ({ id: "s", name });
  it("hides the supplier when the contact already has its name (accents/case ignored)", () => {
    expect(
      supplierSuffix({ name: "Electrica oriental", supplier: supplier("Eléctrica Oriental") }),
    ).toBeNull();
    expect(
      supplierSuffix({ name: "Pinturas del Sur", supplier: supplier("Pinturas del Sur") }),
    ).toBeNull();
  });
  it("shows it otherwise", () => {
    expect(
      supplierSuffix({
        name: "Ventas Distribuidora Norte",
        supplier: supplier("Distribuidora Norte S.A."),
      }),
    ).toBe("Distribuidora Norte S.A.");
    expect(supplierSuffix({ name: null, supplier: supplier("Norte") })).toBe("Norte");
    expect(supplierSuffix({ name: "Ana", supplier: null })).toBeNull();
  });
});

describe("statusTone (phase 14 #9)", () => {
  it("only a failed send is an error; a canceled one (a person took over) is neutral", () => {
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("canceled")).toBe("canceled");
    for (const ok of ["pending", "sent", "delivered", "read", ""]) {
      expect(statusTone(ok)).toBe("normal");
    }
  });
});
