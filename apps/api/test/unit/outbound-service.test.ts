import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/common/errors/app-error.js";
import type {
  OutboundForSend,
  OutboundRepository,
  RecipientContact,
} from "../../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../../src/modules/messaging/outbound.service.js";
import {
  WhatsAppSendError,
  type WhatsAppSendClient,
} from "../../src/modules/whatsapp/whatsapp-send.client.js";

const log = pino({ level: "silent" });
const NOW = new Date("2026-09-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function recipient(
  overrides: {
    lastInboundAt?: Date | null;
    optInAt?: Date | null;
    waId?: string | null;
    bsuid?: string | null;
    conversation?: boolean;
    mode?: "bot" | "human";
    optOutAt?: Date | null;
  } = {},
): RecipientContact {
  return {
    contact: {
      id: "c1",
      waId: overrides.waId === undefined ? "59899000111" : overrides.waId,
      bsuid: overrides.bsuid ?? null,
      optInAt: overrides.optInAt === undefined ? hoursAgo(48) : overrides.optInAt,
      optInSource: overrides.optInAt === null ? null : "inbound",
      optOutAt: overrides.optOutAt ?? null,
    },
    conversation:
      overrides.conversation === false
        ? null
        : {
            id: "v1",
            lastInboundAt:
              overrides.lastInboundAt === undefined ? hoursAgo(1) : overrides.lastInboundAt,
            mode: overrides.mode ?? "bot",
            humanUntil: null,
            modeChangedAt: null,
          },
  };
}

function setup(
  options: {
    found?: RecipientContact | null;
    forSend?: Partial<OutboundForSend> | null;
    sendError?: Error;
    markAcceptedError?: Error;
    claim?: "claimed" | "canceled" | "not_pending";
    settings?: Record<string, unknown>;
  } = {},
) {
  const repository: OutboundRepository = {
    findByIdempotencyKey: vi.fn(async () => null),
    findRecipient: vi.fn(async () => (options.found === undefined ? recipient() : options.found)),
    recordOptIn: vi.fn(async () => ({
      contactId: "c1",
      optInAt: NOW,
      optInSource: "manual" as const,
      created: false,
    })),
    createOutbound: vi.fn(async () => ({
      messageId: "m1",
      conversationId: "v1",
      duplicate: false,
    })),
    createOutboundInTx: vi.fn(async () => ({
      messageId: "m1",
      conversationId: "v1",
      duplicate: false as const,
    })),
    getForSend: vi.fn(async () =>
      options.forSend === null
        ? null
        : {
            id: "m1",
            status: "pending" as const,
            waMessageId: null,
            type: "text",
            purpose: "auto_reply" as const,
            conversationId: "v1",
            lastInboundAt: hoursAgo(1),
            contactOptInAt: hoursAgo(48),
            contactOptOutAt: null,
            request: { to: "59899000111" },
            ...options.forSend,
          },
    ),
    markAccepted: vi.fn(async () => {
      if (options.markAcceptedError) throw options.markAcceptedError;
      return { appliedStatuses: 0 };
    }),
    markFailed: vi.fn(async () => {}),
    claimForSend: vi.fn(async () => options.claim ?? ("claimed" as const)),
    cancelPending: vi.fn(async () => true),
  };
  const client: WhatsAppSendClient = {
    send: vi.fn(async () => {
      if (options.sendError) throw options.sendError;
      return { wamid: "wamid.OUT", messageStatus: null, waId: "59899000111", userId: null };
    }),
  };
  const service = createOutboundService({
    repository,
    client,
    now: () => NOW,
    ...(options.settings ? { settings: { getAll: async () => options.settings! } } : {}),
  });
  return { service, repository, client };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

describe("OutboundService.send — rules", () => {
  it("queues free-form text inside the 24h window", async () => {
    const { service, repository } = setup();
    await expect(
      service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      ),
    ).resolves.toEqual({ messageId: "m1", conversationId: "v1", duplicate: false });
    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text",
        text: "Hola",
        request: expect.objectContaining({ to: "59899000111", type: "text" }),
      }),
    );
  });

  it("refuses text outside the window with WINDOW_CLOSED and stores nothing", async () => {
    const { service, repository } = setup({ found: recipient({ lastInboundAt: hoursAgo(25) }) });
    const err = await expectAppError(
      service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      ),
      "WINDOW_CLOSED",
    );
    expect(err.statusCode).toBe(409);
    expect(err.details).toMatchObject({ lastInboundAt: hoursAgo(25).toISOString() });
    expect(repository.createOutbound).not.toHaveBeenCalled();
  });

  it("refuses text to an unknown contact with WINDOW_CLOSED", async () => {
    const { service } = setup({ found: null });
    await expectAppError(
      service.send(
        {
          recipient: { waId: "59800000000" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
        },
        log,
      ),
      "WINDOW_CLOSED",
    );
  });

  it("allows templates outside the window when the contact opted in", async () => {
    const { service, repository } = setup({ found: recipient({ lastInboundAt: hoursAgo(72) }) });
    await service.send(
      {
        recipient: { waId: "59899000111" },
        content: { kind: "template", name: "hello_world", languageCode: "en_US" },
        author: "bot",
      },
      log,
    );
    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ type: "template", text: "[template hello_world en_US]" }),
    );
  });

  it.each([
    ["an unknown contact", null],
    ["a contact without opt-in", recipient({ optInAt: null })],
  ])("refuses templates to %s with OPT_IN_REQUIRED", async (_label, found) => {
    const { service, repository } = setup({ found });
    await expectAppError(
      service.send(
        {
          recipient: { waId: "59899000222" },
          content: { kind: "template", name: "hello_world", languageCode: "en_US" },
          author: "bot",
        },
        log,
      ),
      "OPT_IN_REQUIRED",
    );
    expect(repository.createOutbound).not.toHaveBeenCalled();
  });

  it("sends to BSUID-only contacts with `recipient`", async () => {
    const { service, repository } = setup({ found: recipient({ waId: null, bsuid: "UY.ABC123" }) });
    await service.send(
      { recipient: { bsuid: "UY.ABC123" }, content: { kind: "text", body: "Hola" }, author: "bot" },
      log,
    );
    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ recipient: "UY.ABC123" }) }),
    );
  });

  it("returns the existing message for a repeated idempotency key", async () => {
    const { service, repository } = setup();
    repository.findByIdempotencyKey = vi.fn(async () => ({
      id: "m-existing",
      status: "sent" as const,
    }));
    await expect(
      service.send(
        {
          recipient: { waId: "59899000111" },
          content: { kind: "text", body: "Hola" },
          author: "bot",
          idempotencyKey: "n8n-run-42:alert",
        },
        log,
      ),
    ).resolves.toEqual({ messageId: "m-existing", conversationId: null, duplicate: true });
    expect(repository.createOutbound).not.toHaveBeenCalled();
  });

  it("validates content (e.g. empty text, bad template name)", async () => {
    const { service } = setup();
    await expect(
      service.send(
        { recipient: { waId: "1" }, content: { kind: "text", body: "  " }, author: "bot" },
        log,
      ),
    ).rejects.toThrow();
    await expect(
      service.send(
        {
          recipient: { waId: "1" },
          content: { kind: "template", name: "Hello World", languageCode: "es" },
          author: "bot",
        },
        log,
      ),
    ).rejects.toThrow();
  });
});

describe("OutboundService.processOutbound — job", () => {
  it("sends and stores the wamid", async () => {
    const { service, repository } = setup();
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "accepted",
    });
    expect(repository.markAccepted).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ wamid: "wamid.OUT" }),
    );
  });

  it("skips messages already sent (idempotent job)", async () => {
    const { service, client } = setup({ forSend: { waMessageId: "wamid.OLD", status: "sent" } });
    expect((await service.processOutbound("m1", log, { finalAttempt: false })).outcome).toBe(
      "already_sent",
    );
    expect(client.send).not.toHaveBeenCalled();
  });

  it("fails text whose window closed while it waited in the queue", async () => {
    const { service, client, repository } = setup({ forSend: { lastInboundAt: hoursAgo(24) } });
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "failed",
      reason: "window_closed",
    });
    expect(client.send).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith("m1", "window_closed", expect.any(String));
  });

  it("fails permanently on a non-retryable Meta error, keeping Meta's code", async () => {
    const { service, repository } = setup({
      sendError: new WhatsAppSendError("template_invalid", false, "no template", 132001, 400),
    });
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "failed",
      reason: "132001",
    });
    expect(repository.markFailed).toHaveBeenCalledWith("m1", "132001", "no template");
  });

  it("throws on retryable errors (pg-boss retries) …", async () => {
    const error = new WhatsAppSendError("rate_limited", true, "rate", 130429, 429);
    const { service, repository } = setup({ sendError: error });
    await expect(service.processOutbound("m1", log, { finalAttempt: false })).rejects.toBe(error);
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("… but settles the last attempt as failed WITHOUT throwing (no blocked conversation)", async () => {
    const { service, repository } = setup({
      sendError: new WhatsAppSendError("rate_limited", true, "rate", 130429, 429),
    });
    expect(await service.processOutbound("m1", log, { finalAttempt: true })).toEqual({
      outcome: "failed",
      reason: "130429",
    });
    expect(repository.markFailed).toHaveBeenCalledOnce();
  });

  it("never retries once Meta accepted the message, even if storing the wamid fails", async () => {
    const { service, client } = setup({ markAcceptedError: new Error("db down") });
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "accepted",
      reason: "wamid_not_stored",
    });
    expect(client.send).toHaveBeenCalledOnce();
  });

  it("fails templates if the opt-in disappeared before sending", async () => {
    const { service } = setup({ forSend: { type: "template", contactOptInAt: null } });
    expect((await service.processOutbound("m1", log, { finalAttempt: false })).reason).toBe(
      "opt_in_required",
    );
  });
});

describe("OutboundService — human takeover (phase 7, ADR-016)", () => {
  const text = { kind: "text" as const, body: "Hola" };

  it("refuses an automatic reply while a person handles the conversation (HUMAN_MODE)", async () => {
    const { service, repository } = setup({ found: recipient({ mode: "human" }) });
    await expectAppError(
      service.send({ recipient: { waId: "59899000111" }, content: text, author: "bot" }, log),
      "HUMAN_MODE",
    );
    expect(repository.createOutbound).not.toHaveBeenCalled();
  });

  it("lets a person reply and team notifications through in human mode", async () => {
    const { service, repository } = setup({ found: recipient({ mode: "human" }) });
    await service.send({ recipient: { waId: "59899000111" }, content: text, author: "human" }, log);
    await service.send(
      {
        recipient: { waId: "59899000111" },
        content: text,
        author: "bot",
        purpose: "team_notification",
      },
      log,
    );
    const purposes = vi
      .mocked(repository.createOutbound)
      .mock.calls.map(([input]) => input.purpose);
    expect(purposes).toEqual(["human", "team_notification"]);
  });

  it("defaults purpose from the author (bot → auto_reply)", async () => {
    const { service, repository } = setup();
    await service.send({ recipient: { waId: "59899000111" }, content: text, author: "bot" }, log);
    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "auto_reply" }),
    );
  });

  it("the job does not call Meta when the claim cancels the message (takeover while queued)", async () => {
    const { service, client } = setup({ claim: "canceled" });
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "canceled",
      reason: "human_takeover",
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("the job skips a message that is no longer pending at claim time", async () => {
    const { service, client } = setup({ claim: "not_pending" });
    expect((await service.processOutbound("m1", log, { finalAttempt: false })).outcome).toBe(
      "already_sent",
    );
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("global automatic-replies switch (phase 9 M6)", () => {
  const off = { "bot.autoRepliesEnabled": false, "optOut.instructionReminderDays": 30 };

  it("send(): an automatic reply is refused; a person's reply and compliance still go", async () => {
    const { service, repository } = setup({ settings: off });
    const text = { kind: "text" as const, body: "Recibimos tu lista" };
    await expectAppError(
      service.send({ recipient: { waId: "59899000111" }, content: text, author: "bot" }, log),
      "AUTO_REPLIES_OFF",
    );
    expect(repository.createOutbound).not.toHaveBeenCalled();
    await service.send(
      { recipient: { waId: "59899000111" }, content: text, author: "human", authorUserId: "u1" },
      log,
    );
    await service.send(
      { recipient: { waId: "59899000111" }, content: text, author: "bot", purpose: "compliance" },
      log,
    );
    expect(repository.createOutbound).toHaveBeenCalledTimes(2);
  });

  it("worker: a queued automatic reply is cancelled if the switch went off meanwhile", async () => {
    const { service, repository, client } = setup({ settings: off });
    expect(await service.processOutbound("m1", log, { finalAttempt: false })).toEqual({
      outcome: "canceled",
      reason: "auto_replies_off",
    });
    expect(repository.cancelPending).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("with the switch on (default) nothing changes", async () => {
    const { service, client } = setup({
      settings: { "bot.autoRepliesEnabled": true, "optOut.instructionReminderDays": 30 },
    });
    expect((await service.processOutbound("m1", log, { finalAttempt: false })).outcome).toBe(
      "accepted",
    );
    expect(client.send).toHaveBeenCalledOnce();
  });
});
