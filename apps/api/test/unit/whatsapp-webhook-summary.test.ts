import { describe, expect, it } from "vitest";
import { summarizeWhatsAppWebhook } from "../../src/modules/whatsapp/whatsapp-webhook.summary.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";

describe("summarizeWhatsAppWebhook", () => {
  it("extracts the Meta error of a failed status, with the recipient masked", () => {
    const summary = summarizeWhatsAppWebhook(whatsappFixtureJson("status-failed"));
    expect(summary).toEqual({
      recognized: true,
      object: "whatsapp_business_account",
      items: [
        {
          kind: "status",
          field: "messages",
          wamid: "wamid.TEST_FAILED_0001",
          status: "failed",
          recipient: "598*****111",
          timestamp: "1790000000",
          errors: [
            {
              code: 131030,
              title: "Recipient phone number not in allowed list",
              details:
                "Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.",
              href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/",
            },
          ],
        },
      ],
    });
  });

  it("summarizes a status without errors", () => {
    const [item] = summarizeWhatsAppWebhook(whatsappFixtureJson("status-sent")).items;
    expect(item).toMatchObject({ kind: "status", status: "sent", errors: [] });
  });

  it("summarizes inbound messages without body, names or full numbers", () => {
    const summary = summarizeWhatsAppWebhook(whatsappFixtureJson("message-text"));
    expect(summary.items).toEqual([
      {
        kind: "message",
        field: "messages",
        wamid: "wamid.ANON_TEXT_0001",
        type: "text",
        from: "598*****111",
        fromUserId: "UY.100…001",
      },
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("59899000111");
    expect(serialized).not.toContain("Test Supplier");
    expect(serialized).not.toContain("tornillo");
  });

  it("masks phone numbers inside error details", () => {
    const summary = summarizeWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.X",
                    status: "failed",
                    errors: [{ code: 1, error_data: { details: "Bad number 59899009160" } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("59899009160");
    expect(summary.items[0]).toMatchObject({
      errors: [{ code: 1, details: "Bad number 598*****160" }],
    });
  });

  it("reports value-level errors and other fields", () => {
    const summary = summarizeWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            { field: "messages", value: { errors: [{ code: 131000, title: "Something" }] } },
            { field: "message_template_status_update", value: {} },
          ],
        },
      ],
    });
    expect(summary.items).toEqual([
      { kind: "error", field: "messages", errors: [{ code: 131000, title: "Something" }] },
      { kind: "other_field", field: "message_template_status_update" },
    ]);
  });

  it("flags payloads that are not WhatsApp webhooks", () => {
    expect(summarizeWhatsAppWebhook({ hello: "world" })).toEqual({ recognized: false, items: [] });
  });
});
