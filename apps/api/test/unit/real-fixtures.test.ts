import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createAnonymizer } from "../../scripts/fixtures/anonymize-webhook.js";
import { planMedia } from "../../src/modules/media/media-policy.js";
import type { WhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { parseWhatsAppWebhook } from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";

/**
 * Real Meta payloads captured on 2026-09-25 (phase 3 M5) and anonymized with
 * wa:fixtures:capture. They document what Meta actually sends today.
 */

function change(name: string) {
  const parsed = parseWhatsAppWebhook(whatsappFixtureJson(name));
  if (!parsed.recognized) throw new Error(`${name} not recognized`);
  const first = parsed.changes[0];
  if (!first) throw new Error(`${name} has no change`);
  return first;
}

describe("real Meta payloads", () => {
  it.each(["message-text", "message-image", "message-document", "message-audio"])(
    "%s: parses with no invalid items, phone + BSUID, and our anonymized business ids",
    (name) => {
      const c = change(name);
      expect(c).toMatchObject({
        field: "messages",
        phoneNumberId: "100000000000001",
        invalidItems: [],
      });
      expect(c.messages[0]).toMatchObject({
        fromWaId: "59899000111",
        fromUserId: "UY.1000000000000001",
        contactName: "Test Supplier",
      });
    },
  );

  it("media messages carry a signed lookaside URL and a base64 sha256 in the webhook", () => {
    for (const name of ["message-image", "message-document", "message-audio"]) {
      const raw = change(name).messages[0]?.raw as Record<
        string,
        { url?: string; sha256?: string }
      >;
      const media = Object.values(raw).find(
        (v) => typeof v === "object" && v !== null && "url" in v,
      );
      expect(media?.url).toMatch(
        /^https:\/\/lookaside\.fbsbx\.com\/whatsapp_business\/attachments\//,
      );
      expect(media?.url).toContain("hash=ANONYMIZED");
      expect(media?.sha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    }
  });

  it("a real voice note is planned for download (and later transcription)", () => {
    const audio = change("message-audio").messages[0];
    expect(audio?.media?.mimeType).toBe("audio/ogg; codecs=opus");
    expect(planMedia("audio", audio?.media?.mimeType)).toEqual({
      action: "download",
      kind: "audio",
    });
  });

  it("status webhooks (sent → delivered → read) share one wamid and carry contacts + pricing.type", () => {
    const statuses = ["status-sent", "status-delivered", "status-read"].map(
      (n) => change(n).statuses[0],
    );
    expect(statuses.map((s) => s?.status)).toEqual(["sent", "delivered", "read"]);
    expect(new Set(statuses.map((s) => s?.waMessageId)).size).toBe(1);
    for (const s of statuses) {
      expect(s).toMatchObject({
        recipientWaId: "59899000111",
        recipientUserId: "UY.1000000000000001",
        errors: [],
        pricing: { type: "free_customer_service", billable: false, category: "utility" },
      });
    }
  });

  it("the `security` field (PIN_RESET_SUCCESS) is ignored by ingestion", async () => {
    const finished: string[] = [];
    const repo = {
      getEvent: vi.fn(async () => ({
        id: "evt",
        status: "received" as const,
        payload: whatsappFixtureJson("field-security"),
      })),
      incrementAttempts: vi.fn(async () => {}),
      finishEvent: vi.fn(async (_id: string, status: string) => {
        finished.push(status);
      }),
      ingestInboundMessage: vi.fn(),
      recordStatus: vi.fn(),
    } as unknown as WhatsAppIngestRepository;
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: "100000000000001",
    });
    expect((await service.processEvent("evt", pino({ level: "silent" }))).outcome).toBe("ignored");
    expect(finished).toEqual(["ignored"]);
  });
});

describe("fixture anonymizer", () => {
  const real = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1414141414141414",
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                display_phone_number: "15551234567",
                phone_number_id: "1263636363636363",
              },
              contacts: [
                {
                  wa_id: "59891234567",
                  user_id: "UY.2626262626262626",
                  profile: { name: "Juan Pérez" },
                },
              ],
              messages: [
                {
                  id: "wamid.HBgLREALREALREAL",
                  from: "59891234567",
                  from_user_id: "UY.2626262626262626",
                  type: "document",
                  document: {
                    id: "2111111111111111",
                    url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=2111111111111111&source=webhook&ext=1790&hash=SECRETHASH",
                    sha256: "abc=",
                    filename: "lista.pdf",
                    mime_type: "application/pdf",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it("replaces every identifier with deterministic fakes and keeps the content", () => {
    const anonymizer = createAnonymizer();
    const fixture = anonymizer.anonymize("message-document", real);
    anonymizer.assertClean([fixture]);
    const text = JSON.stringify(fixture.payload);
    for (const secret of [
      "59891234567",
      "UY.2626262626262626",
      "Juan Pérez",
      "SECRETHASH",
      "1263636363636363",
      "1414141414141414",
      "15551234567",
      "2111111111111111",
      "wamid.HBgLREALREALREAL",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"filename":"lista.pdf"');
    expect(text).toContain('"from":"59899000111"');
    expect(text).toContain('"from_user_id":"UY.1000000000000001"');
    expect(text).toContain("wamid.ANON_DOCUMENT_0001");
    expect(text).toContain("mid=9000000000000001");
    expect(text).toContain("hash=ANONYMIZED");
  });

  it("keeps the mapping consistent across a batch (same wamid → same fake)", () => {
    const anonymizer = createAnonymizer();
    const status = (s: string) => ({
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.SAME", status: s, recipient_id: "59891234567" }] },
            },
          ],
        },
      ],
    });
    const a = anonymizer.anonymize("status-sent", status("sent"));
    const b = anonymizer.anonymize("status-read", status("read"));
    const id = (f: typeof a) => JSON.stringify(f.payload).match(/wamid\.ANON_[A-Z_]+_\d+/)?.[0];
    expect(id(a)).toBe(id(b));
  });

  it("refuses to write when an identifier leaks through an unexpected field", () => {
    const anonymizer = createAnonymizer();
    const fixture = anonymizer.anonymize("message-text", {
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.X",
                    from: "59891234567",
                    type: "text",
                    text: { body: "mi número es 59891234567" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(() => anonymizer.assertClean([fixture])).toThrow(/leaked 1 original value/);
  });
});
