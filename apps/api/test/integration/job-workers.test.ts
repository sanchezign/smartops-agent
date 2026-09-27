import { Writable } from "node:stream";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoss } from "../../src/jobs/boss.js";
import { registerConversationModeWorkers } from "../../src/jobs/conversation-mode.job.js";
import { registerDocumentConversionWorkers } from "../../src/jobs/document-conversion.job.js";
import { registerMediaTranscriptionWorkers } from "../../src/jobs/media-transcription.job.js";
import { registerN8nDeliveryWorkers } from "../../src/jobs/n8n-delivery.job.js";
import { registerNotificationDigestWorkers } from "../../src/jobs/notification-digest.job.js";
import { QUEUE_DEFINITIONS, QUEUES } from "../../src/jobs/queues.js";
import { registerWhatsAppMediaWorkers } from "../../src/jobs/whatsapp-media.job.js";
import { registerWhatsAppWebhookWorkers } from "../../src/jobs/whatsapp-webhook.job.js";
import { testDatabaseUrl } from "./db.js";

/**
 * The job wiring with REAL pg-boss (phase 10 M3): each worker's failure path records the
 * error and rethrows (→ pg-boss retry), exhausted jobs land in the queue's DLQ and its handler
 * settles the row; cron queues get their schedules; queue creation is idempotent and applies
 * the options of QUEUE_DEFINITIONS. Services are stubs that always fail — their own logic is
 * tested elsewhere. (The outbound DLQ, which also unblocks the conversation, is covered in
 * outbound.test.ts.)
 */

type Call = [string, ...unknown[]];

describe.skipIf(!testDatabaseUrl)("job workers (real pg-boss)", () => {
  let boss: PgBoss;
  const calls: Call[] = [];
  const logs: { level: number; msg: string; attempt?: number; eventId?: string }[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(JSON.parse(chunk.toString()) as (typeof logs)[number]);
        done();
      },
    }),
  );
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return true;
    };
  const boom = (name: string) => async (id: string) => {
    calls.push([name, id]);
    throw new Error(`${name} exploded`);
  };
  const callsTo = (name: string, id: string) =>
    calls.filter(([n, first]) => n === name && first === id);

  beforeAll(async () => {
    boss = await startBoss({ databaseUrl: testDatabaseUrl!, logger, role: "worker" });
    // Jobs left by other files would reach the always-failing stubs: start clean.
    for (const q of QUEUE_DEFINITIONS) await boss.deleteAllJobs(q.name);

    await registerWhatsAppWebhookWorkers(boss, {
      ingest: { processEvent: boom("processEvent") } as never,
      repository: {
        recordEventError: record("recordEventError"),
        markEventFailed: record("markEventFailed"),
      } as never,
      sweeper: { run: async () => undefined } as never,
      logger,
      concurrency: 2,
    });
    await registerWhatsAppMediaWorkers(boss, {
      service: { processMediaFile: boom("processMediaFile") } as never,
      repository: {
        recordError: record("media.recordError"),
        markFinal: record("media.markFinal"),
      } as never,
      logger,
      concurrency: 2,
    });
    await registerMediaTranscriptionWorkers(boss, {
      service: { processTranscription: boom("processTranscription") } as never,
      repository: {
        recordError: record("transcription.recordError"),
        markFinal: record("transcription.markFinal"),
      } as never,
      logger,
      concurrency: 1,
    });
    await registerDocumentConversionWorkers(boss, {
      service: { processConversion: boom("processConversion") } as never,
      repository: {
        recordError: record("conversion.recordError"),
        markFailed: record("conversion.markFailed"),
      } as never,
      logger,
      concurrency: 1,
    });
    await registerN8nDeliveryWorkers(boss, {
      service: { deliver: boom("deliver") } as never,
      repository: { markFailed: record("n8n.markFailed") } as never,
      watchdog: { run: async () => undefined } as never,
      logger,
    });
    await registerNotificationDigestWorkers(boss, {
      service: { processDigest: boom("processDigest") } as never,
      logger,
    });
    await registerConversationModeWorkers(boss, {
      service: { onTimeout: boom("onTimeout"), sweepExpired: async () => undefined } as never,
      logger,
    });
  }, 60_000);

  afterAll(async () => {
    if (!boss) return;
    for (const q of QUEUE_DEFINITIONS) await boss.deleteAllJobs(q.name);
    await boss.stop({ graceful: true, timeout: 10_000 });
  });

  const ID = () => crypto.randomUUID();
  const until = (fn: () => boolean) =>
    expect.poll(fn, { timeout: 20_000, interval: 200 }).toBe(true);

  it("queue creation is idempotent and applies QUEUE_DEFINITIONS", async () => {
    const again = await startBoss({ databaseUrl: testDatabaseUrl!, logger, role: "api" });
    try {
      for (const def of QUEUE_DEFINITIONS) {
        const q = await again.getQueue(def.name);
        expect(q, def.name).toMatchObject({
          name: def.name,
          ...(def.retryLimit !== undefined ? { retryLimit: def.retryLimit } : {}),
          ...(def.retryDelay !== undefined ? { retryDelay: def.retryDelay } : {}),
          ...(def.retryBackoff !== undefined ? { retryBackoff: def.retryBackoff } : {}),
          ...(def.retryDelayMax !== undefined ? { retryDelayMax: def.retryDelayMax } : {}),
          ...(def.expireInSeconds !== undefined ? { expireInSeconds: def.expireInSeconds } : {}),
          ...(def.deadLetter ? { deadLetter: def.deadLetter } : {}),
          ...(def.policy ? { policy: def.policy } : {}),
        });
      }
    } finally {
      await again.stop({ graceful: false });
    }
  }, 60_000);

  it("the three cron queues are scheduled with their cron expression", async () => {
    const schedules = await boss.getSchedules();
    const cron = Object.fromEntries(schedules.map((s) => [s.name, s.cron]));
    expect(cron).toMatchObject({
      [QUEUES.webhookSweeper]: "* * * * *",
      [QUEUES.n8nWatchdog]: "*/5 * * * *",
      [QUEUES.conversationModeSweeper]: "*/5 * * * *",
    });
  });

  it("a failing webhook job records each error, is retried, then dead-lettered → event failed", async () => {
    const eventId = ID();
    await boss.send(QUEUES.whatsappWebhook, { eventId }, { retryLimit: 1, retryDelay: 1 });
    await until(() => callsTo("markEventFailed", eventId).length === 1);
    expect(callsTo("processEvent", eventId)).toHaveLength(2); // first try + 1 retry
    expect(callsTo("recordEventError", eventId)).toEqual([
      ["recordEventError", eventId, "Error: processEvent exploded"],
      ["recordEventError", eventId, "Error: processEvent exploded"],
    ]);
    expect(callsTo("markEventFailed", eventId)[0]).toEqual([
      "markEventFailed",
      eventId,
      `retries exhausted on ${QUEUES.whatsappWebhook}`,
    ]);
    const attempts = logs
      .filter((l) => l.eventId === eventId && l.attempt !== undefined)
      .map((l) => l.attempt);
    expect(new Set(attempts)).toEqual(new Set([1, 2]));
  }, 30_000);

  it.each([
    [
      "media",
      QUEUES.whatsappMedia,
      "processMediaFile",
      "media.recordError",
      "media.markFinal",
      ["failed", "retries_exhausted"],
    ],
    [
      "transcription",
      QUEUES.mediaTranscription,
      "processTranscription",
      "transcription.recordError",
      "transcription.markFinal",
      ["failed", "retries_exhausted"],
    ],
    [
      "conversion",
      QUEUES.documentConversion,
      "processConversion",
      "conversion.recordError",
      "conversion.markFailed",
      [{ reason: "retries_exhausted", detail: null, durationMs: null }],
    ],
  ] as const)(
    "%s: error recorded, dead letter settles the media file",
    async (_label, queue, work, recordError, settle, settleArgs) => {
      const mediaFileId = ID();
      await boss.send(queue, { mediaFileId }, { retryLimit: 0 });
      await until(() => callsTo(settle, mediaFileId).length === 1);
      expect(callsTo(work, mediaFileId)).toHaveLength(1);
      expect(callsTo(recordError, mediaFileId)).toHaveLength(1);
      expect(callsTo(settle, mediaFileId)[0]).toEqual([settle, mediaFileId, ...settleArgs]);
    },
    30_000,
  );

  it("n8n delivery: exhausted → event failed (+ alert, in the repository)", async () => {
    const eventId = ID();
    await boss.send(QUEUES.n8nDelivery, { eventId }, { retryLimit: 0 });
    await until(() => callsTo("n8n.markFailed", eventId).length === 1);
    expect(callsTo("deliver", eventId)).toHaveLength(1);
    expect(logs.some((l) => l.eventId === eventId && /permanently failed/.test(l.msg))).toBe(true);
  }, 30_000);

  it("a digest that cannot be sent ends in its DLQ with an error log (stays in the panel)", async () => {
    const digestId = ID();
    await boss.send(QUEUES.notificationDigest, { digestId }, { retryLimit: 0 });
    await until(() =>
      logs.some(
        (l) =>
          (l as { digestId?: string }).digestId === digestId &&
          l.level >= 50 &&
          /could not be sent/.test(l.msg),
      ),
    );
    expect(callsTo("processDigest", digestId)).toHaveLength(1);
  }, 30_000);

  it("bot resume has no DLQ: after its retries the job just fails (the sweeper covers it)", async () => {
    const conversationId = ID();
    const jobId = await boss.send(
      QUEUES.conversationBotResume,
      { conversationId },
      { retryLimit: 0 },
    );
    await until(() => callsTo("onTimeout", conversationId).length === 1);
    await expect
      .poll(async () => (await boss.getJobById(QUEUES.conversationBotResume, jobId!))?.state, {
        timeout: 10_000,
      })
      .toBe("failed");
  }, 30_000);
});
