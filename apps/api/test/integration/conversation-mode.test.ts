import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createScheduleBotResumeInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import {
  createConversationModeRepository,
  type ScheduleBotResumeInTx,
} from "../../src/modules/conversations/conversation-mode.repository.js";
import { createConversationModeService } from "../../src/modules/conversations/conversation-mode.service.js";
import { createOutboundRepository } from "../../src/modules/messaging/outbound.repository.js";
import { createOutboundService } from "../../src/modules/messaging/outbound.service.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import type { WhatsAppSendClient } from "../../src/modules/whatsapp/whatsapp-send.client.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Bot / human mode against real Postgres + pg-boss (phase 7, ADR-016): the takeover is
 * atomic (mode + history + cancellation + reactivation job), races with the outbound
 * worker never send a cancelled message, stale jobs are no-ops, the sweeper recovers lost
 * jobs and late echoes do not pause again.
 */

const log = pino({ level: "silent" });
const T0 = new Date("2026-09-26T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe.skipIf(!testDatabaseUrl)("conversation mode against Postgres + pg-boss", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let clock = T0;

  const settings = () => createSettingsService({ repository: createSettingsRepository(prisma) });
  const modeRepository = (schedule?: ScheduleBotResumeInTx) =>
    createConversationModeRepository(prisma, {
      scheduleBotResumeInTx: schedule ?? createScheduleBotResumeInTx(boss),
    });
  const modeService = (schedule?: ScheduleBotResumeInTx) =>
    createConversationModeService({
      repository: modeRepository(schedule),
      settings: settings(),
      now: () => clock,
    });
  const outboundRepository = () =>
    createOutboundRepository(prisma, { enqueueOutboundInTx: async () => {} });

  let conversationId: string;

  async function pendingAutoReply(text = "Recibimos tu lista"): Promise<string> {
    const contact = await prisma.contact.findFirstOrThrow({ where: { waId: "59899000111" } });
    const { messageId } = await outboundRepository().createOutbound({
      contactId: contact.id,
      type: "text",
      text,
      author: "bot",
      purpose: "auto_reply",
      request: { to: "59899000111", type: "text", text: { body: text } },
    });
    return messageId;
  }

  const message = (id: string) => prisma.message.findUniqueOrThrow({ where: { id } });
  const conversation = () =>
    prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const resumeJobs = () =>
    prisma.$queryRawUnsafe<{ data: { conversationId: string }; start_after: Date }[]>(
      `SELECT data, start_after FROM pgboss.job WHERE name = $1 ORDER BY start_after`,
      QUEUES.conversationBotResume,
    );

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await boss.deleteAllJobs(QUEUES.conversationBotResume);
    clock = T0;
    const contact = await prisma.contact.create({
      data: { waId: "59899000111", kind: "supplier", optInAt: at(-60), optInSource: "inbound" },
    });
    conversationId = (
      await prisma.conversation.create({
        data: { contactId: contact.id, lastInboundAt: at(-1) },
      })
    ).id;
  });

  it("a human reply switches to human, cancels the queued auto reply, records who, and schedules the reactivation — atomically", async () => {
    const queued = await pendingAutoReply();
    const result = await modeService().apply(
      conversationId,
      { type: "human_message", source: "panel" },
      { label: "cli:ana" },
      log,
    );
    expect(result.canceledMessages).toBe(1);
    expect(await message(queued)).toMatchObject({
      status: "canceled",
      errorCode: "human_takeover",
    });
    expect(await conversation()).toMatchObject({
      mode: "human",
      humanUntil: at(120),
      modeChangedAt: T0,
    });
    const history = await prisma.conversationModeChange.findMany({ where: { conversationId } });
    expect(history).toEqual([
      expect.objectContaining({
        fromMode: "bot",
        toMode: "human",
        reason: "human_reply_panel",
        actorLabel: "cli:ana",
        humanUntil: at(120),
      }),
    ]);
    const jobs = await resumeJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ conversationId });
    expect(jobs[0]?.start_after).toEqual(at(120));
  });

  it("if scheduling the reactivation fails, nothing changes (one transaction)", async () => {
    const queued = await pendingAutoReply();
    const broken: ScheduleBotResumeInTx = async () => {
      throw new Error("pg-boss down");
    };
    await expect(
      modeService(broken).apply(conversationId, { type: "human_message", source: "app" }, {}, log),
    ).rejects.toThrow("pg-boss down");
    expect(await conversation()).toMatchObject({ mode: "bot", humanUntil: null });
    expect(await message(queued)).toMatchObject({ status: "pending" });
    expect(await prisma.conversationModeChange.count()).toBe(0);
  });

  it("race: worker claim vs. human takeover — a cancelled message is never sent, a claimed one is never cancelled (×25)", async () => {
    const repository = outboundRepository();
    const service = modeService(async () => {});
    for (let i = 0; i < 25; i += 1) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { mode: "bot", humanUntil: null, modeChangedAt: null },
      });
      const id = await pendingAutoReply(`msg ${i}`);
      const [claim, takeover] = await Promise.all([
        repository.claimForSend(id, clock),
        service.apply(conversationId, { type: "human_message", source: "app" }, {}, log),
      ]);
      const row = await message(id);
      if (claim === "claimed") {
        // In flight: the takeover must have left it alone.
        expect(row.status).toBe("pending");
        expect(row.claimedAt).not.toBeNull();
        expect(takeover.canceledMessages).toBe(0);
      } else {
        expect(row.status).toBe("canceled");
        expect(row.claimedAt).toBeNull();
      }
    }
  });

  it("the outbound job never calls Meta for an auto reply queued before the takeover", async () => {
    const queued = await pendingAutoReply();
    // The takeover happens while the job waits; simulate a message that escaped the
    // bulk cancellation by flipping the mode directly.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { mode: "human", humanUntil: at(120), modeChangedAt: T0 },
    });
    let calls = 0;
    const client: WhatsAppSendClient = {
      send: async () => {
        calls += 1;
        return { wamid: "wamid.X", messageStatus: null, waId: null, userId: null };
      },
    };
    const outbound = createOutboundService({
      repository: outboundRepository(),
      client,
      now: () => clock,
    });
    expect(await outbound.processOutbound(queued, log, { finalAttempt: false })).toEqual({
      outcome: "canceled",
      reason: "human_takeover",
    });
    expect(calls).toBe(0);
    expect(await message(queued)).toMatchObject({ status: "canceled" });
  });

  it("human replies and team notifications still go out in human mode; new auto replies are refused", async () => {
    const outbound = createOutboundService({
      repository: outboundRepository(),
      client: { send: async () => ({ wamid: "w", messageStatus: null, waId: null, userId: null }) },
      now: () => clock,
    });
    await modeService(async () => {}).apply(
      conversationId,
      { type: "pause", until: null },
      {},
      log,
    );
    const text = { kind: "text" as const, body: "Hola" };
    await expect(
      outbound.send({ recipient: { conversationId }, content: text, author: "bot" }, log),
    ).rejects.toMatchObject({ code: "HUMAN_MODE" });
    await outbound.send({ recipient: { conversationId }, content: text, author: "human" }, log);
    await outbound.send(
      { recipient: { conversationId }, content: text, author: "bot", purpose: "team_notification" },
      log,
    );
    const purposes = await prisma.message.findMany({
      where: { conversationId },
      select: { purpose: true },
      orderBy: { createdAt: "asc" },
    });
    expect(purposes.map((p) => p.purpose)).toEqual(["human", "team_notification"]);
  });

  it("timeout: a stale job after an extension is a no-op; the last one reactivates the bot", async () => {
    const service = modeService();
    await service.apply(conversationId, { type: "human_message", source: "app" }, {}, log);
    clock = at(60);
    await service.apply(conversationId, { type: "human_message", source: "panel" }, {}, log);
    expect(await conversation()).toMatchObject({ humanUntil: at(180) });
    expect((await resumeJobs()).map((j) => j.start_after)).toEqual([at(120), at(180)]);

    clock = at(121); // first job fires
    expect((await service.onTimeout(conversationId, log)).decision).toEqual({
      changed: false,
      ignored: "not_expired",
    });
    clock = at(180); // second job fires
    expect((await service.onTimeout(conversationId, log)).decision.changed).toBe(true);
    expect(await conversation()).toMatchObject({
      mode: "bot",
      humanUntil: null,
      modeChangedAt: at(180),
    });
    const reasons = await prisma.conversationModeChange.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { reason: true, actorLabel: true },
    });
    expect(reasons).toEqual([
      { reason: "human_reply_app", actorLabel: null },
      { reason: "human_reply_panel", actorLabel: null },
      { reason: "timeout", actorLabel: "system" },
    ]);
  });

  it("an indefinite pause survives timeouts until someone resumes it", async () => {
    const service = modeService(async () => {});
    await service.pause({ conversationId }, { minutes: null }, { label: "cli:ana" }, log);
    clock = at(10_000);
    expect((await service.onTimeout(conversationId, log)).decision.changed).toBe(false);
    expect(await service.sweepExpired(log)).toBe(0);
    await service.resume({ waId: "59899000111" }, { label: "cli:ana" }, log);
    expect(await conversation()).toMatchObject({ mode: "bot" });
  });

  it("the sweeper reactivates expired conversations whose job was lost", async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { mode: "human", humanUntil: at(-5), modeChangedAt: at(-125) },
    });
    const service = modeService(async () => {});
    expect(await service.sweepExpired(log)).toBe(1);
    expect(await conversation()).toMatchObject({ mode: "bot" });
    expect(await service.sweepExpired(log)).toBe(0);
  });

  it("a late echo written before a manual resume does not pause the bot again", async () => {
    const service = modeService(async () => {});
    await service.apply(conversationId, { type: "human_message", source: "app" }, {}, log);
    clock = at(10);
    await service.resume({ conversationId }, { label: "cli:ana" }, log);
    clock = at(11);
    const late = await service.apply(
      conversationId,
      { type: "human_message", source: "app", messageAt: at(9) },
      {},
      log,
    );
    expect(late.decision).toEqual({ changed: false, ignored: "stale_human_message" });
    expect(await conversation()).toMatchObject({ mode: "bot" });
  });

  it("the status view shows who took over and until when", async () => {
    const service = modeService(async () => {});
    await service.pause({ waId: "59899000111" }, { minutes: 30 }, { label: "cli:ana" }, log);
    expect(await service.status({ waId: "59899000111" })).toMatchObject({
      mode: "human",
      humanUntil: at(30),
      lastChange: { reason: "manual_pause", actorLabel: "cli:ana" },
    });
  });
});
