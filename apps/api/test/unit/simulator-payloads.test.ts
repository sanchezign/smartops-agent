import { describe, expect, it } from "vitest";
import { fakeBsuidFor, fakeMediaId, fakeWamid } from "../../scripts/simulator/ids.js";
import { formatSha256 } from "../../scripts/simulator/media-store.js";
import {
  buildInboundMessage,
  buildStatus,
  type SimBusiness,
  type SimContact,
} from "../../scripts/simulator/payloads.js";
import {
  isBsuid,
  parseWhatsAppWebhook,
} from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";

/** The simulator must produce payloads the production parser accepts, field by field. */

const business: SimBusiness = {
  phoneNumberId: "100000000000001",
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const contact: SimContact = {
  waId: "59899000111",
  bsuid: fakeBsuidFor("59899000111"),
  name: "Proveedor Simulado",
};

function parseFirst(payload: unknown) {
  const parsed = parseWhatsAppWebhook(payload);
  if (!parsed.recognized) throw new Error("not recognized");
  const change = parsed.changes[0];
  if (!change) throw new Error("no change");
  expect(change.invalidItems).toEqual([]);
  return change;
}

describe("simulator ids", () => {
  it("look like Meta ids", () => {
    expect(fakeWamid()).toMatch(/^wamid\.[A-Za-z0-9_-]+$/);
    expect(fakeMediaId()).toMatch(/^[1-9]\d{15}$/);
    expect(isBsuid(fakeBsuidFor("59899000111"))).toBe(true);
  });

  it("gives the same simulated contact the same BSUID", () => {
    expect(fakeBsuidFor("59899000111")).toBe(fakeBsuidFor("59899000111"));
    expect(fakeBsuidFor("59899000111")).not.toBe(fakeBsuidFor("59899000222"));
  });

  it("formats sha256 as hex or base64", () => {
    const hex = "ab".repeat(32);
    expect(formatSha256(hex, "hex")).toBe(hex);
    expect(Buffer.from(formatSha256(hex, "base64"), "base64").toString("hex")).toBe(hex);
  });
});

describe("buildInboundMessage", () => {
  it("builds a text message the parser reads back identically", () => {
    const at = new Date("2026-09-24T12:00:00Z");
    const { wamid, payload } = buildInboundMessage(
      business,
      contact,
      { type: "text", body: "Lista: tornillo 6mm $12" },
      { at },
    );
    const change = parseFirst(payload);
    expect(change.phoneNumberId).toBe(business.phoneNumberId);
    expect(change.messages[0]).toMatchObject({
      waMessageId: wamid,
      fromWaId: "59899000111",
      fromUserId: contact.bsuid,
      contactName: "Proveedor Simulado",
      type: "text",
      text: "Lista: tornillo 6mm $12",
      timestamp: at,
    });
  });

  it("builds media messages with id, mime, sha256, filename and caption", () => {
    const { payload } = buildInboundMessage(business, contact, {
      type: "document",
      media: {
        id: "9000000000000001",
        mimeType: "application/pdf",
        sha256: "ab".repeat(32),
        filename: "lista.pdf",
        caption: "Lista septiembre",
      },
    });
    expect(parseFirst(payload).messages[0]).toMatchObject({
      type: "document",
      text: "Lista septiembre",
      media: {
        waMediaId: "9000000000000001",
        mimeType: "application/pdf",
        sha256: "ab".repeat(32),
        filename: "lista.pdf",
      },
    });
  });

  it("builds a BSUID-only sender (no from / wa_id)", () => {
    const { payload } = buildInboundMessage(
      business,
      { ...contact, waId: null, username: "ferreteria.sur" },
      { type: "text", body: "hola" },
    );
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain('"from":');
    expect(raw).not.toContain('"wa_id"');
    expect(parseFirst(payload).messages[0]).toMatchObject({
      fromWaId: null,
      fromUserId: contact.bsuid,
      username: "ferreteria.sur",
    });
  });

  it("builds interactive button replies", () => {
    const { payload } = buildInboundMessage(business, contact, {
      type: "interactive",
      title: "Confirmar pedido",
    });
    expect(parseFirst(payload).messages[0]).toMatchObject({
      type: "interactive",
      text: "Confirmar pedido",
    });
  });

  it("refuses a contact without phone or BSUID", () => {
    expect(() =>
      buildInboundMessage(business, { waId: null, bsuid: null }, { type: "text", body: "x" }),
    ).toThrow();
  });
});

describe("buildStatus", () => {
  it("builds delivered statuses with recipient BSUID and pricing", () => {
    const status = parseFirst(
      buildStatus(business, { wamid: "wamid.X", status: "delivered", recipient: contact }),
    ).statuses[0];
    expect(status).toMatchObject({
      waMessageId: "wamid.X",
      status: "delivered",
      recipientWaId: "59899000111",
      recipientUserId: contact.bsuid,
      pricing: { category: "service" },
      errors: [],
    });
  });

  it("builds failed statuses with Meta's title and details for known codes", () => {
    const status = parseFirst(
      buildStatus(business, {
        wamid: "wamid.X",
        status: "failed",
        recipient: contact,
        errors: [{ code: 131030 }],
      }),
    ).statuses[0];
    expect(status?.errors[0]).toMatchObject({
      code: 131030,
      title: "Recipient phone number not in allowed list",
      error_data: { details: expect.stringContaining("allowed list") },
    });
    expect(status?.pricing).toBeNull();
  });
});
