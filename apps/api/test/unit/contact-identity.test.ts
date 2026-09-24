import { describe, expect, it } from "vitest";
import {
  MissingIdentityError,
  planContactUpsert,
  type ExistingContact,
} from "../../src/modules/whatsapp/contact-identity.js";

const PHONE = "59899000111";
const BSUID = "UY.1A2B3C4D5E6F7G8H9I0J";

function contact(overrides: Partial<ExistingContact> = {}): ExistingContact {
  return { id: "c1", waId: null, bsuid: null, name: null, username: null, ...overrides };
}

const incoming = { waId: PHONE, bsuid: BSUID, name: "Proveedor", username: null };

describe("planContactUpsert", () => {
  it("creates a contact when nobody matches", () => {
    expect(planContactUpsert(null, null, incoming)).toEqual({
      plan: { action: "create", data: incoming },
    });
  });

  it("fills the BSUID on a contact known only by phone", () => {
    const existing = contact({ waId: PHONE, name: "Proveedor" });
    expect(planContactUpsert(null, existing, incoming)).toEqual({
      plan: { action: "update", id: "c1", data: { bsuid: BSUID } },
    });
  });

  it("fills the phone on a contact known only by BSUID", () => {
    const existing = contact({ bsuid: BSUID, name: "Proveedor" });
    expect(planContactUpsert(existing, null, incoming)).toEqual({
      plan: { action: "update", id: "c1", data: { waId: PHONE } },
    });
  });

  it("updates the profile name and username when they change", () => {
    const existing = contact({ waId: PHONE, bsuid: BSUID, name: "Viejo" });
    expect(
      planContactUpsert(existing, existing, { ...incoming, username: "ferreteria.sur" }).plan,
    ).toEqual({
      action: "update",
      id: "c1",
      data: { name: "Proveedor", username: "ferreteria.sur" },
    });
  });

  it("does nothing when everything is already known", () => {
    const existing = contact({ waId: PHONE, bsuid: BSUID, name: "Proveedor" });
    expect(planContactUpsert(existing, existing, incoming)).toEqual({
      plan: { action: "none", id: "c1" },
    });
  });

  it("does not erase a stored name when the payload has none", () => {
    const existing = contact({ waId: PHONE, bsuid: BSUID, name: "Proveedor" });
    expect(planContactUpsert(existing, existing, { ...incoming, name: null }).plan.action).toBe(
      "none",
    );
  });

  it("reports (and does not merge) a phone/BSUID conflict between two contacts", () => {
    const byBsuid = contact({ id: "a", bsuid: BSUID });
    const byWaId = contact({ id: "b", waId: PHONE });
    const result = planContactUpsert(byBsuid, byWaId, incoming);
    expect(result.conflict).toEqual({ bsuidContactId: "a", waIdContactId: "b" });
    // Uses the BSUID contact and never steals the phone from contact "b".
    expect(result.plan).toEqual({ action: "update", id: "a", data: { name: "Proveedor" } });
  });

  it("rejects a message with neither phone nor BSUID", () => {
    expect(() =>
      planContactUpsert(null, null, { waId: null, bsuid: null, name: null, username: null }),
    ).toThrow(MissingIdentityError);
  });
});
