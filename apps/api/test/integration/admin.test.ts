import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { createRunRetrigger } from "../../src/modules/admin/run-retrigger.js";
import { createEmitMessageReadyInTx } from "../../src/modules/integration/message-ready.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/** Panel API pieces against Postgres (phase 8 M4): run re-trigger, audited settings writes. */

describe.skipIf(!testDatabaseUrl)("admin services (Postgres)", () => {
  let prisma: PrismaClient;
  let enqueued: string[];
  let userId: string;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await prisma.$executeRawUnsafe(
      "TRUNCATE TABLE integration_events, ingestion_runs, audit_logs, settings, users CASCADE",
    );
    enqueued = [];
    userId = (
      await prisma.user.create({
        data: { email: "a@x.uy", name: "Ana", passwordHash: "x", role: "admin" },
      })
    ).id;
  });

  async function runWith(status: "classified" | "ingested" | "pending") {
    const contact = await prisma.contact.create({ data: { waId: "59899000111" } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "inbound",
        type: "document",
        author: "contact",
      },
    });
    return prisma.ingestionRun.create({ data: { messageId: message.id, status } });
  }

  const retrigger = () =>
    createRunRetrigger({
      prisma,
      emitMessageReadyInTx: createEmitMessageReadyInTx(async (_tx, eventId) => {
        enqueued.push(eventId);
      }),
    });

  it("re-emits message.ready once per approval for a run sent back to extraction", async () => {
    const run = await runWith("classified");
    expect(await retrigger()(run.id, "review:r1")).toEqual({ retriggered: true });
    expect(await retrigger()(run.id, "review:r1")).toEqual({ retriggered: false }); // same approval
    expect(await retrigger()(run.id, "review:r2")).toEqual({ retriggered: true });
    const keys = (await prisma.integrationEvent.findMany()).map((e) => e.dedupeKey).sort();
    expect(keys).toEqual([
      `message.ready:${run.messageId}:review:r1`,
      `message.ready:${run.messageId}:review:r2`,
    ]);
    expect(enqueued).toHaveLength(2);
  });

  it("does nothing for a run that is already processed", async () => {
    const run = await runWith("ingested");
    expect(await retrigger()(run.id, "review:r1")).toEqual({ retriggered: false });
    expect(await prisma.integrationEvent.count()).toBe(0);
  });

  it("settings writes are validated with the key's schema and audited (who, from, to)", async () => {
    const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
    await expect(
      settings.set!("coexistence.humanTakeoverMinutes", 0, { userId }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(settings.set!("no.such.key", 1, { userId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await settings.set!("coexistence.humanTakeoverMinutes", 60, { userId });
    await settings.set!("coexistence.humanTakeoverMinutes", 90, { userId });
    expect((await settings.getAll(undefined as never))["coexistence.humanTakeoverMinutes"]).toBe(
      90,
    );
    const audit = await prisma.auditLog.findMany({
      where: { action: "setting.updated" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.data)).toEqual([
      { from: null, to: 60 },
      { from: 60, to: 90 },
    ]);
    expect(audit[0]).toMatchObject({ userId, entityId: "coexistence.humanTakeoverMinutes" });
    expect(
      await prisma.setting.findUniqueOrThrow({
        where: { key: "coexistence.humanTakeoverMinutes" },
      }),
    ).toMatchObject({ updatedById: userId });
  });
});
