import { describe, expect, it } from "vitest";
import {
  buildSendPayload,
  classifySendError,
} from "../../src/modules/whatsapp/whatsapp-send.client.js";

describe("classifySendError", () => {
  it.each([
    [131047, 400, "window_closed", false],
    [131026, 400, "recipient_unreachable", false],
    [131030, 400, "recipient_unreachable", false],
    [132000, 400, "template_invalid", false],
    [132001, 400, "template_invalid", false],
    [132012, 400, "template_invalid", false],
    [100, 400, "bad_request", false],
    [131008, 400, "bad_request", false],
    [131009, 400, "bad_request", false],
    [190, 401, "unauthorized", false],
    [368, 403, "account_restricted", false],
    [131031, 400, "account_restricted", false],
    [131050, 400, "recipient_opted_out", false],
    [130429, 429, "rate_limited", true],
    [131056, 400, "rate_limited", true],
    [131000, 500, "transient", true],
    [undefined, 503, "transient", true],
    [undefined, 429, "rate_limited", true],
    [undefined, 401, "unauthorized", false],
    [undefined, 422, "bad_request", false],
    [undefined, undefined, "transient", true],
  ] as const)("code %s / HTTP %s → %s (retryable %s)", (code, http, category, retryable) => {
    expect(classifySendError(code, http)).toEqual({ category, retryable });
  });
});

describe("buildSendPayload", () => {
  it("sends text to a phone number with `to`", () => {
    expect(buildSendPayload({ waId: "59899000111" }, { kind: "text", body: "Hola" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "59899000111",
      type: "text",
      text: { body: "Hola", preview_url: false },
    });
  });

  it("sends to a BSUID with `recipient` (never `to`)", () => {
    const payload = buildSendPayload({ bsuid: "UY.ABC123" }, { kind: "text", body: "Hola" });
    expect(payload.recipient).toBe("UY.ABC123");
    expect(payload).not.toHaveProperty("to");
  });

  it("builds templates with language and components, and replies with context", () => {
    expect(
      buildSendPayload(
        { waId: "59899000111" },
        {
          kind: "template",
          name: "price_alert",
          languageCode: "es",
          components: [{ type: "body", parameters: [{ type: "text", text: "12%" }] }],
        },
        { replyToWamid: "wamid.X" },
      ),
    ).toMatchObject({
      context: { message_id: "wamid.X" },
      type: "template",
      template: {
        name: "price_alert",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: "12%" }] }],
      },
    });
  });

  it("omits empty components", () => {
    const payload = buildSendPayload(
      { waId: "1" },
      { kind: "template", name: "hello_world", languageCode: "en_US", components: [] },
    );
    expect(payload.template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });
});
