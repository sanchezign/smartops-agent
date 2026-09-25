import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../scripts/simulator/fake-graph.js";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import { createMediaStore, type MediaStore } from "../../scripts/simulator/media-store.js";
import { buildInboundMessage } from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import { createEnqueueTranscriptionInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import {
  createMediaRepository,
  type OnMediaStoredInTx,
} from "../../src/modules/media/media.repository.js";
import { createMediaDownloadService } from "../../src/modules/media/media.service.js";
import { createFakeTranscriber } from "../../src/modules/transcription/providers/fake.js";
import {
  TranscriptionError,
  type Transcriber,
} from "../../src/modules/transcription/transcriber.js";
import {
  createOnAudioStoredInTx,
  createTranscriptionRepository,
} from "../../src/modules/transcription/transcription.repository.js";
import { createTranscriptionService } from "../../src/modules/transcription/transcription.service.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppMediaClient } from "../../src/modules/whatsapp/whatsapp-media.client.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { SAMPLES } from "../helpers/media-samples.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Phase 4 end to end without Meta or Groq: simulator audio webhook → ingestion →
 * media download (fake Graph API) → [same transaction] pending transcription + job
 * (real pg-boss) → transcription service (fake transcriber) → Message.transcript.
 */

const TOKEN = "EAAfake-token-for-stt-tests-000";
const PHONE_NUMBER_ID = "100000000000001";
const business = {
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const contact = { waId: "59899000111", bsuid: fakeBsuidFor("59899000111"), name: "Proveedor" };
const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("voice-note transcription pipeline", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let dir: string;
  let mediaStore: MediaStore;
  let transcriptsDir: string;
  let fake: FakeGraph;
  let graphUrl: string;

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
    dir = mkdtempSync(join(tmpdir(), "smartops-stt-it-"));
    mediaStore = createMediaStore(join(dir, "media"));
    transcriptsDir = join(dir, "transcripts");
    fake = createFakeGraph({
      business,
      accessToken: TOKEN,
      appSecret: "unused-signature-secret-000000",
      webhookUrl: "http://127.0.0.1:9/unused",
      mediaStore,
      logger: log,
    });
    graphUrl = await fake.listen(0);
  });

  afterAll(async () => {
    await fake?.close();
    await boss?.stop({ graceful: false, close: true });
    await prisma?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    await boss.deleteAllJobs(QUEUES.mediaTranscription);
  });

  afterEach(() => {
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  /** Simulator webhook → ingest → media download (stored). Returns the MediaFile id. */
  async function receiveAudio(
    bytes: Uint8Array,
    mimeType: string,
    options: {
      transcript?: string;
      onStoredInTx?: OnMediaStoredInTx;
      type?: "audio" | "document";
    } = {},
  ): Promise<string> {
    const stored = mediaStore.register(bytes, { mimeType });
    if (options.transcript) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(transcriptsDir, { recursive: true });
      writeFileSync(join(transcriptsDir, `${stored.sha256Hex}.txt`), options.transcript);
    }
    const { payload } = buildInboundMessage(business, contact, {
      type: options.type ?? "audio",
      media: { id: stored.id, mimeType, sha256: stored.sha256Hex, voice: true },
    });
    const event = await createWhatsAppWebhookRepository(prisma).saveEvent({
      bodySha256: `${stored.sha256Hex}`,
      payload,
    });
    if (event.duplicate) throw new Error("unexpected duplicate");
    await createWhatsAppIngestService({
      repository: createWhatsAppIngestRepository(prisma, { enqueueMediaInTx: async () => {} }),
      phoneNumberId: PHONE_NUMBER_ID,
    }).processEvent(event.id, log);

    const mediaFile = await prisma.mediaFile.findFirstOrThrow({ where: { waMediaId: stored.id } });
    const media = createMediaDownloadService({
      repository: createMediaRepository(prisma, {
        onStoredInTx:
          options.onStoredInTx ??
          createOnAudioStoredInTx({
            enqueueTranscriptionInTx: createEnqueueTranscriptionInTx(boss),
          }),
      }),
      storage: createPostgresMediaStorage(prisma),
      client: createWhatsAppMediaClient({
        graph: { baseUrl: graphUrl, version: "v26.0", accessToken: TOKEN, timeoutMs: 5_000 },
        phoneNumberId: PHONE_NUMBER_ID,
        downloadTimeoutMs: 5_000,
        production: false,
      }),
      maxBytes: 25 * 1024 * 1024,
    });
    await media.processMediaFile(mediaFile.id, log).catch(() => {});
    return mediaFile.id;
  }

  function transcriptionService(options: { transcriber?: Transcriber; limit?: number } = {}) {
    return createTranscriptionService({
      repository: createTranscriptionRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      transcriber: options.transcriber ?? createFakeTranscriber({ transcriptsDir }),
      language: "es",
      prompt: "lista de precios",
      dailyLimitPerContact: options.limit ?? 50,
    });
  }

  it("transcribes a voice note into the message (job enqueued atomically with media stored)", async () => {
    const id = await receiveAudio(SAMPLES.ogg, "audio/ogg; codecs=opus", {
      transcript: "El tornillo de 6mm sube a 14 pesos",
    });
    expect(
      await prisma.transcription.findUniqueOrThrow({ where: { mediaFileId: id } }),
    ).toMatchObject({
      status: "pending",
    });
    expect(
      await boss.findJobs(QUEUES.mediaTranscription, { data: { mediaFileId: id } }),
    ).toHaveLength(1);

    expect(await transcriptionService().processTranscription(id, log)).toEqual({ outcome: "done" });

    expect(
      await prisma.transcription.findUniqueOrThrow({ where: { mediaFileId: id } }),
    ).toMatchObject({
      status: "done",
      provider: "fake",
      language: "es",
      text: "El tornillo de 6mm sube a 14 pesos",
      attempts: 1,
    });
    expect(await prisma.message.findFirstOrThrow({ where: { mediaFileId: id } })).toMatchObject({
      type: "audio",
      transcript: "El tornillo de 6mm sube a 14 pesos",
    });
    // Re-running the job is a no-op.
    expect((await transcriptionService().processTranscription(id, log)).outcome).toBe(
      "already_done",
    );
  });

  it("documents and images get no transcription", async () => {
    const id = await receiveAudio(SAMPLES.pdf, "application/pdf", { type: "document" });
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id } })).status).toBe("stored");
    expect(await prisma.transcription.count()).toBe(0);
  });

  it("AAC voice audio is stored but skipped as unsupported_format", async () => {
    const aac = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]);
    const id = await receiveAudio(aac, "audio/aac");
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id } })).status).toBe("stored");
    expect(await transcriptionService().processTranscription(id, log)).toEqual({
      outcome: "skipped",
      reason: "unsupported_format",
    });
  });

  it("the daily per-contact limit skips further transcriptions", async () => {
    const service = transcriptionService({ limit: 1 });
    const first = await receiveAudio(SAMPLES.ogg, "audio/ogg");
    const second = await receiveAudio(Buffer.concat([SAMPLES.ogg, Buffer.from("x")]), "audio/ogg");
    expect((await service.processTranscription(first, log)).outcome).toBe("done");
    expect(await service.processTranscription(second, log)).toEqual({
      outcome: "skipped",
      reason: "quota_exceeded",
    });
  });

  it("a transient provider error is retried and then succeeds", async () => {
    const id = await receiveAudio(SAMPLES.ogg, "audio/ogg", { transcript: "stock agotado" });
    const inner = createFakeTranscriber({ transcriptsDir });
    let calls = 0;
    const flaky: Transcriber = {
      ...inner,
      supports: inner.supports,
      async transcribe(input) {
        calls += 1;
        if (calls === 1) throw new TranscriptionError("rate_limited", true, "429", 429, 5);
        return inner.transcribe(input);
      },
    };
    const service = transcriptionService({ transcriber: flaky });
    await expect(service.processTranscription(id, log)).rejects.toThrow();
    expect(
      (await prisma.transcription.findUniqueOrThrow({ where: { mediaFileId: id } })).status,
    ).toBe("pending");
    expect((await service.processTranscription(id, log)).outcome).toBe("done");
    expect((await prisma.message.findFirstOrThrow({ where: { mediaFileId: id } })).transcript).toBe(
      "stock agotado",
    );
  });

  it("rolls back media 'stored' when the transcription enqueue fails (atomic)", async () => {
    const id = await receiveAudio(SAMPLES.ogg, "audio/ogg", {
      onStoredInTx: async () => {
        throw new Error("queue down");
      },
    });
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(await prisma.transcription.count()).toBe(0);
    expect(
      await boss.findJobs(QUEUES.mediaTranscription, { data: { mediaFileId: id } }),
    ).toHaveLength(0);
  });

  it("resetFailed puts failed transcriptions back to pending (wa:transcription:retry)", async () => {
    const id = await receiveAudio(SAMPLES.ogg, "audio/ogg");
    const repository = createTranscriptionRepository(prisma);
    await repository.markFinal(id, "failed", "retries_exhausted");
    expect(await repository.resetFailed({ limit: 10 })).toEqual([id]);
    expect(
      await prisma.transcription.findUniqueOrThrow({ where: { mediaFileId: id } }),
    ).toMatchObject({
      status: "pending",
      attempts: 0,
      reason: null,
    });
  });
});
