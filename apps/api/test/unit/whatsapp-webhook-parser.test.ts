import { describe, expect, it } from "vitest";
import {
  isBsuid,
  parseWaTimestamp,
  parseWhatsAppWebhook,
  type ParsedChange,
} from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";

function firstChange(fixture: string): ParsedChange {
  const parsed = parseWhatsAppWebhook(whatsappFixtureJson(fixture));
  if (!parsed.recognized) throw new Error(`${fixture} not recognized`);
  const change = parsed.changes[0];
  if (!change) throw new Error(`${fixture} has no changes`);
  return change;
}

describe("parseWhatsAppWebhook — inbound messages", () => {
  it("parses a real text message with phone, BSUID and profile name", () => {
    const change = firstChange("message-text");
    expect(change).toMatchObject({ field: "messages", phoneNumberId: "100000000000001" });
    expect(change.messages[0]).toMatchObject({
      waMessageId: "wamid.ANON_TEXT_0001",
      fromWaId: "59899000111",
      fromUserId: "UY.1000000000000001",
      contactName: "Test Supplier",
      type: "text",
      text: "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU",
      media: null,
      timestamp: new Date(1_790_307_685 * 1000),
    });
  });

  it.each([
    // Real payloads: WhatsApp converts photos to JPEG; no caption was sent with them.
    ["message-image", "image", "image/jpeg", null],
    ["message-document", "document", "application/pdf", "lista-prueba.pdf"],
    ["message-audio", "audio", "audio/ogg; codecs=opus", null],
  ])("parses real %s media metadata", (fixture, type, mimeType, filename) => {
    const message = firstChange(fixture).messages[0];
    expect(message).toMatchObject({ type, text: null, fromUserId: "UY.1000000000000001" });
    expect(message?.media).toMatchObject({ mimeType, filename });
    expect(message?.media?.waMediaId).toMatch(/^9000/);
    // Meta sends the media sha256 in base64 (not hex).
    expect(message?.media?.sha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("uses the button title as text for interactive replies", () => {
    expect(firstChange("message-interactive").messages[0]).toMatchObject({
      type: "interactive",
      text: "Confirmar pedido",
    });
  });

  it("keeps unsupported messages with their Meta error", () => {
    const message = firstChange("message-unsupported").messages[0];
    expect(message).toMatchObject({ type: "unsupported", waType: "unsupported" });
    expect(message?.errors[0]?.code).toBe(131051);
  });

  it("maps unknown Meta types (e.g. system, order) to unsupported, keeping the raw type", () => {
    const parsed = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.SYS",
                    from: "59899000111",
                    type: "system",
                    system: { body: "User changed number" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.recognized && parsed.changes[0]?.messages[0]).toMatchObject({
      type: "unsupported",
      waType: "system",
      text: "User changed number",
    });
  });

  it("handles a BSUID-only sender (no wa_id / from) with username", () => {
    expect(firstChange("message-bsuid-only").messages[0]).toMatchObject({
      fromWaId: null,
      fromUserId: "UY.9Z8Y7X6W5V4U3T2S1R0Q",
      username: "ferreteria.sur",
      contactName: "Username User",
    });
  });

  it("treats a BSUID in `from` as a user id, not a phone number", () => {
    const parsed = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.X", from: "UY.ABC123", type: "text", text: { body: "hola" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.recognized && parsed.changes[0]?.messages[0]).toMatchObject({
      fromWaId: null,
      fromUserId: "UY.ABC123",
    });
  });
});

describe("parseWhatsAppWebhook — statuses", () => {
  it("parses a failed status with its errors", () => {
    expect(firstChange("status-failed").statuses[0]).toMatchObject({
      waMessageId: "wamid.TEST_FAILED_0001",
      status: "failed",
      recipientWaId: "59899000111",
      errors: [expect.objectContaining({ code: 131030 })],
    });
  });

  it("parses recipient BSUID and pricing", () => {
    expect(firstChange("status-delivered-bsuid").statuses[0]).toMatchObject({
      status: "delivered",
      recipientWaId: "59899000111",
      recipientUserId: "UY.1A2B3C4D5E6F7G8H9I0J",
      pricing: { category: "service" },
    });
  });
});

describe("parseWhatsAppWebhook — robustness", () => {
  it("reports the Meta dashboard sample with its foreign phone_number_id", () => {
    const change = firstChange("dashboard-test-message");
    expect(change.phoneNumberId).toBe("123456123");
    expect(change.messages).toHaveLength(1);
  });

  it("isolates invalid items instead of rejecting the whole delivery", () => {
    const parsed = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.OK", from: "59899000111", type: "text", text: { body: "ok" } },
                  { from: "59899000111", type: "text" },
                ],
                statuses: [{ status: "sent" }],
              },
            },
          ],
        },
      ],
    });
    if (!parsed.recognized) throw new Error("not recognized");
    expect(parsed.changes[0]?.messages.map((m) => m.waMessageId)).toEqual(["wamid.OK"]);
    expect(parsed.changes[0]?.invalidItems).toEqual([
      { kind: "message", index: 1 },
      { kind: "status", index: 0 },
    ]);
  });

  it("does not recognize arbitrary JSON", () => {
    expect(parseWhatsAppWebhook({ foo: 1 })).toEqual({ recognized: false });
  });
});

describe("helpers", () => {
  it("parses unix-seconds timestamps", () => {
    expect(parseWaTimestamp("1790000000")).toEqual(new Date(1_790_000_000_000));
    expect(parseWaTimestamp("not-a-number")).toBeNull();
    expect(parseWaTimestamp(undefined)).toBeNull();
  });

  it("detects BSUIDs", () => {
    expect(isBsuid("US.13491208655302741918")).toBe(true);
    expect(isBsuid("59899000111")).toBe(false);
  });
});
