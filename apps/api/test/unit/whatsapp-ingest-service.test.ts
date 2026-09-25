import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type {
  IngestMessageResult,
  StoredWebhookEvent,
  WhatsAppIngestRepository,
} from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { whatsappFixtureJson } from "../helpers/fixtures.js";

const PHONE_NUMBER_ID = "100000000000001";

/** Fake repository: records calls; dedupes messages/statuses like the DB constraints do. */
function fakeRepository(event: StoredWebhookEvent | null) {
  const seenMessages = new Set<string>();
  const seenStatuses = new Set<string>();
  const finished: { status: string; note?: string }[] = [];
  const repo: WhatsAppIngestRepository = {
    getEvent: vi.fn(async () => event),
    incrementAttempts: vi.fn(async () => {}),
    finishEvent: vi.fn(async (_id, status, note) => {
      finished.push({ status, ...(note ? { note } : {}) });
    }),
    recordEventError: vi.fn(async () => {}),
    markEventFailed: vi.fn(async () => {}),
    ingestInboundMessage: vi.fn(async ({ message }): Promise<IngestMessageResult> => {
      if (seenMessages.has(message.waMessageId)) return { outcome: "duplicate" };
      seenMessages.add(message.waMessageId);
      return { outcome: "created", messageId: "m1", contactId: "c1", conversationId: "v1" };
    }),
    recordStatus: vi.fn(async ({ status }) => {
      const key = `${status.waMessageId}:${status.status}`;
      const duplicate = seenStatuses.has(key);
      seenStatuses.add(key);
      return { duplicate, messageId: null, messageUpdated: false };
    }),
  };
  return { repo, finished };
}

function event(payload: unknown, status: StoredWebhookEvent["status"] = "received") {
  return { id: "evt-1", status, payload };
}

function captureLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { log: pino({ level: "trace" }, sink), lines };
}

describe("WhatsAppIngestService.processEvent", () => {
  it("stores an inbound message, calls the inbound hook and marks the event processed", async () => {
    const { repo, finished } = fakeRepository(event(whatsappFixtureJson("message-text")));
    const onInboundMessage = vi.fn(async () => {});
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
      onInboundMessage,
    });

    const result = await service.processEvent("evt-1", captureLogger().log);

    expect(result).toMatchObject({ outcome: "processed", messagesCreated: 1 });
    expect(repo.incrementAttempts).toHaveBeenCalledOnce();
    expect(onInboundMessage).toHaveBeenCalledOnce();
    expect(onInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", conversationId: "v1" }),
    );
    expect(finished).toEqual([{ status: "processed" }]);
  });

  it("does not call the hook again for a duplicate message", async () => {
    const payload = whatsappFixtureJson("message-text");
    const { repo } = fakeRepository(event(payload));
    const onInboundMessage = vi.fn(async () => {});
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
      onInboundMessage,
    });

    await service.processEvent("evt-1", captureLogger().log);
    const second = await service.processEvent("evt-1", captureLogger().log);

    expect(second).toMatchObject({ messagesCreated: 0, duplicateMessages: 1 });
    expect(onInboundMessage).toHaveBeenCalledOnce();
  });

  it("records statuses without triggering the inbound hook", async () => {
    const { repo } = fakeRepository(event(whatsappFixtureJson("status-delivered-bsuid")));
    const onInboundMessage = vi.fn(async () => {});
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
      onInboundMessage,
    });

    const result = await service.processEvent("evt-1", captureLogger().log);

    expect(result).toMatchObject({ statusesRecorded: 1, messagesCreated: 0 });
    expect(onInboundMessage).not.toHaveBeenCalled();
  });

  it("logs failed statuses at warn with the Meta code and masked recipient", async () => {
    const { repo } = fakeRepository(event(whatsappFixtureJson("status-failed")));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });
    const { log, lines } = captureLogger();

    await service.processEvent("evt-1", log);

    const failed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === "whatsapp status: failed");
    expect(failed).toMatchObject({
      level: 40,
      wamid: "wamid.TEST_FAILED_0001",
      recipient: "598*****111",
      errors: [expect.objectContaining({ code: 131030 })],
    });
    expect(lines.join("")).not.toContain("59899000111");
  });

  it("never logs full phone numbers, BSUIDs, names or bodies", async () => {
    const { repo } = fakeRepository(event(whatsappFixtureJson("message-image")));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });
    const { log, lines } = captureLogger();

    await service.processEvent("evt-1", log);

    const logs = lines.join("");
    expect(logs).toContain("598*****111");
    expect(logs).toContain("UY.100…001");
    for (const secret of [
      "59899000111",
      "UY.1000000000000001",
      "Test Supplier",
      "lookaside.fbsbx.com", // signed media URL from the webhook
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("ignores the Meta dashboard test payload (foreign phone_number_id)", async () => {
    const { repo, finished } = fakeRepository(event(whatsappFixtureJson("dashboard-test-message")));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    const result = await service.processEvent("evt-1", captureLogger().log);

    expect(result.outcome).toBe("ignored");
    expect(repo.ingestInboundMessage).not.toHaveBeenCalled();
    expect(finished).toEqual([
      { status: "ignored", note: "no messages change for this phone_number_id" },
    ]);
  });

  it("ignores fields it does not handle yet", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "smb_message_echoes", value: {} }] }],
    };
    const { repo, finished } = fakeRepository(event(payload));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect((await service.processEvent("evt-1", captureLogger().log)).outcome).toBe("ignored");
    expect(finished[0]?.status).toBe("ignored");
  });

  it("marks unrecognized payloads as ignored", async () => {
    const { repo, finished } = fakeRepository(event({ hello: "world" }));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect((await service.processEvent("evt-1", captureLogger().log)).outcome).toBe("ignored");
    expect(finished).toEqual([{ status: "ignored", note: "unrecognized payload" }]);
  });

  it("skips events that are no longer `received` (idempotent re-delivery of the job)", async () => {
    const { repo } = fakeRepository(event(whatsappFixtureJson("message-text"), "processed"));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect((await service.processEvent("evt-1", captureLogger().log)).outcome).toBe("skipped");
    expect(repo.incrementAttempts).not.toHaveBeenCalled();
    expect(repo.ingestInboundMessage).not.toHaveBeenCalled();
  });

  it("returns not_found for a deleted event", async () => {
    const { repo } = fakeRepository(null);
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });
    expect((await service.processEvent("evt-x", captureLogger().log)).outcome).toBe("not_found");
  });

  it("skips (and counts) messages with neither phone nor BSUID", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [{ id: "wamid.ANON", type: "text", text: { body: "?" } }],
              },
            },
          ],
        },
      ],
    };
    const { repo } = fakeRepository(event(payload));
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    const result = await service.processEvent("evt-1", captureLogger().log);
    expect(result).toMatchObject({ outcome: "processed", skippedItems: 1, messagesCreated: 0 });
    expect(repo.ingestInboundMessage).not.toHaveBeenCalled();
  });

  it("propagates repository errors so pg-boss retries the job", async () => {
    const { repo } = fakeRepository(event(whatsappFixtureJson("message-text")));
    repo.ingestInboundMessage = vi.fn(async () => {
      throw new Error("db down");
    });
    const service = createWhatsAppIngestService({
      repository: repo,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    await expect(service.processEvent("evt-1", captureLogger().log)).rejects.toThrow("db down");
    expect(repo.finishEvent).not.toHaveBeenCalled();
  });

  describe("media plan passed to the repository", () => {
    function mediaEvent(type: string, media: Record<string, unknown>) {
      return event({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "1",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_NUMBER_ID },
                  messages: [{ id: `wamid.${type}`, from: "59899000111", type, [type]: media }],
                },
              },
            ],
          },
        ],
      });
    }

    it.each([
      ["document", { id: "1", mime_type: "application/pdf" }, { status: "pending" }],
      ["audio", { id: "2", mime_type: "audio/ogg; codecs=opus" }, { status: "pending" }],
      [
        "video",
        { id: "3", mime_type: "video/mp4" },
        { status: "skipped", rejectReason: "type_not_downloaded" },
      ],
      [
        "document",
        { id: "4", mime_type: "application/x-msdownload" },
        { status: "rejected", rejectReason: "unsupported_mime" },
      ],
    ])("%s %o → %o", async (type, media, expected) => {
      const { repo } = fakeRepository(mediaEvent(type, media));
      const service = createWhatsAppIngestService({
        repository: repo,
        phoneNumberId: PHONE_NUMBER_ID,
      });
      await service.processEvent("evt-1", captureLogger().log);
      expect(repo.ingestInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ mediaPlan: expected }),
      );
    });

    it("text messages carry no media plan", async () => {
      const { repo } = fakeRepository(event(whatsappFixtureJson("message-text")));
      const service = createWhatsAppIngestService({
        repository: repo,
        phoneNumberId: PHONE_NUMBER_ID,
      });
      await service.processEvent("evt-1", captureLogger().log);
      expect(repo.ingestInboundMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ mediaPlan: expect.anything() }),
      );
    });
  });
});
