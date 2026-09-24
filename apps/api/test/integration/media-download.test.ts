import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeGraph,
  type FakeGraph,
  type FakeGraphOptions,
} from "../../scripts/simulator/fake-graph.js";
import { fakeBsuidFor } from "../../scripts/simulator/ids.js";
import {
  createMediaStore,
  formatSha256,
  type MediaStore,
} from "../../scripts/simulator/media-store.js";
import { buildInboundMessage, type SimMessage } from "../../scripts/simulator/payloads.js";
import type { PrismaClient } from "../../src/common/db.js";
import { createEnqueueMediaInTx, startBoss } from "../../src/jobs/boss.js";
import { QUEUES } from "../../src/jobs/queues.js";
import { createPostgresMediaStorage } from "../../src/modules/media/media-storage.js";
import { createMediaRepository } from "../../src/modules/media/media.repository.js";
import { createMediaDownloadService } from "../../src/modules/media/media.service.js";
import { createWhatsAppIngestRepository } from "../../src/modules/whatsapp/whatsapp-ingest.repository.js";
import { createWhatsAppIngestService } from "../../src/modules/whatsapp/whatsapp-ingest.service.js";
import { createWhatsAppMediaClient } from "../../src/modules/whatsapp/whatsapp-media.client.js";
import { createWhatsAppWebhookRepository } from "../../src/modules/whatsapp/whatsapp-webhook.repository.js";
import { SAMPLES } from "../helpers/media-samples.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Milestone 3 end to end, without Meta: simulator webhook payload → ingest (real repo,
 * MediaFile + job in one transaction) → media service with the PRODUCTION client and
 * Postgres storage, against the fake Graph API. Real pg-boss for the atomic-enqueue check.
 */

const TOKEN = "EAAfake-token-for-media-tests-0";
const PHONE_NUMBER_ID = "100000000000001";
const business = {
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};
const contact = { waId: "59899000111", bsuid: fakeBsuidFor("59899000111"), name: "Proveedor" };
const log = pino({ level: "silent" });

describe.skipIf(!testDatabaseUrl)("media download against Postgres + fake Graph API", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let mediaDir: string;
  let mediaStore: MediaStore;
  let fake: FakeGraph | undefined;
  let enqueued: string[];

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({ databaseUrl: testDatabaseUrl ?? "", logger: log, role: "api" });
    mediaDir = mkdtempSync(join(tmpdir(), "smartops-media-"));
    mediaStore = createMediaStore(mediaDir);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
    await prisma?.$disconnect();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetWhatsAppTables(prisma);
    enqueued = [];
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function startFake(overrides: Partial<FakeGraphOptions> = {}) {
    fake = createFakeGraph({
      business,
      accessToken: TOKEN,
      appSecret: "unused-in-these-tests-000000",
      webhookUrl: "http://127.0.0.1:9/unused",
      mediaStore,
      logger: log,
      ...overrides,
    });
    return fake.listen(0);
  }

  function mediaService(baseUrl: string, options: { token?: string; maxBytes?: number } = {}) {
    return createMediaDownloadService({
      repository: createMediaRepository(prisma),
      storage: createPostgresMediaStorage(prisma),
      client: createWhatsAppMediaClient({
        graph: { baseUrl, version: "v26.0", accessToken: options.token ?? TOKEN, timeoutMs: 5_000 },
        phoneNumberId: PHONE_NUMBER_ID,
        downloadTimeoutMs: 5_000,
        production: false,
      }),
      maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
    });
  }

  /** Simulator webhook → real ingestion. Returns the MediaFile id. */
  async function receiveMedia(
    type: "image" | "document" | "audio" | "video",
    bytes: Uint8Array,
    mimeType: string,
    options: { filename?: string; shaFormat?: "hex" | "base64" } = {},
  ): Promise<string> {
    const stored = mediaStore.register(bytes, { mimeType, filename: options.filename ?? null });
    const message: SimMessage = {
      type,
      media: {
        id: stored.id,
        mimeType,
        sha256: formatSha256(stored.sha256Hex, options.shaFormat ?? "hex"),
        filename: options.filename ?? null,
      },
    };
    const { payload } = buildInboundMessage(business, contact, message);
    const event = await createWhatsAppWebhookRepository(prisma).saveEvent({
      bodySha256: stored.sha256Hex,
      payload,
    });
    if (event.duplicate) throw new Error("unexpected duplicate");

    const ingest = createWhatsAppIngestService({
      repository: createWhatsAppIngestRepository(prisma, {
        enqueueMediaInTx: async (_tx, mediaFileId) => {
          enqueued.push(mediaFileId);
        },
      }),
      phoneNumberId: PHONE_NUMBER_ID,
    });
    await ingest.processEvent(event.id, log);
    const mediaFile = await prisma.mediaFile.findFirstOrThrow({ where: { waMediaId: stored.id } });
    return mediaFile.id;
  }

  const mediaFile = (id: string) => prisma.mediaFile.findUniqueOrThrow({ where: { id } });

  it("downloads a PDF and stores it byte for byte in media_blobs", async () => {
    const service = mediaService(await startFake());
    const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf", {
      filename: "lista.pdf",
    });
    expect(enqueued).toEqual([id]);

    expect(await service.processMediaFile(id, log)).toEqual({ outcome: "stored" });

    expect(await mediaFile(id)).toMatchObject({
      status: "stored",
      storage: "postgres",
      sizeBytes: SAMPLES.pdf.length,
      filename: "lista.pdf",
      attempts: 1,
    });
    const stored = await createPostgresMediaStorage(prisma).get(id);
    expect(Buffer.from(stored ?? [])).toEqual(SAMPLES.pdf);

    // Re-running the job is a no-op.
    expect((await service.processMediaFile(id, log)).outcome).toBe("already_done");
  });

  it.each([
    ["image", "image/jpeg", SAMPLES.jpeg],
    ["audio", "audio/ogg; codecs=opus", SAMPLES.ogg],
    ["document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", SAMPLES.xlsx],
  ] as const)("stores %s (%s)", async (type, mime, bytes) => {
    const service = mediaService(await startFake());
    const id = await receiveMedia(type, bytes, mime);
    expect((await service.processMediaFile(id, log)).outcome).toBe("stored");
  });

  it("accepts Meta's sha256 in base64", async () => {
    const service = mediaService(await startFake({ shaFormat: "base64" }));
    const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf", {
      shaFormat: "base64",
    });
    expect((await service.processMediaFile(id, log)).outcome).toBe("stored");
  });

  it("requests a fresh URL when the download URL expired", async () => {
    // media-info → t=0 (URL valid 5 min); download → t=10 min (expired); media-info again → valid.
    const clock = [0, 10 * 60_000, 10 * 60_000, 10 * 60_000];
    let tick = 0;
    const service = mediaService(
      await startFake({ now: () => clock[Math.min(tick++, clock.length - 1)] ?? 0 }),
    );
    const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf");
    expect((await service.processMediaFile(id, log)).outcome).toBe("stored");
  });

  it("video is skipped at ingest: no job, no download", async () => {
    const id = await receiveMedia("video", Buffer.from("fake-mp4"), "video/mp4");
    expect(enqueued).toEqual([]);
    expect(await mediaFile(id)).toMatchObject({
      status: "skipped",
      rejectReason: "type_not_downloaded",
    });
  });

  it("rejects an .exe sent as application/pdf (magic bytes)", async () => {
    const service = mediaService(await startFake());
    const id = await receiveMedia("document", SAMPLES.exe, "application/pdf");
    expect((await service.processMediaFile(id, log)).reason).toBe("content_mismatch");
    expect(await mediaFile(id)).toMatchObject({
      status: "rejected",
      rejectReason: "content_mismatch",
    });
    expect(await createPostgresMediaStorage(prisma).get(id)).toBeNull();
  });

  it("rejects files above MEDIA_MAX_BYTES", async () => {
    const service = mediaService(await startFake(), { maxBytes: 1024 });
    const big = Buffer.concat([SAMPLES.pdf, Buffer.alloc(4096, 0x20)]);
    const id = await receiveMedia("document", big, "application/pdf");
    expect((await service.processMediaFile(id, log)).reason).toBe("too_large");
  });

  it("fails permanently when the media id does not exist (media-info 404)", async () => {
    const service = mediaService(await startFake({ faults: { "media-info": 404 } }));
    const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf");
    expect((await service.processMediaFile(id, log)).reason).toBe("media_not_found");
    expect((await mediaFile(id)).status).toBe("failed");
  });

  it.each([
    ["an invalid token (401)", {}, "wrong-token-000000000000000"],
    ["a download 500", { faults: { download: 500 } }, undefined],
    ["a corrupt download (checksum mismatch)", { faults: { download: "corrupt" } }, undefined],
  ] as const)(
    "throws on %s so pg-boss retries; the file stays pending",
    async (_l, overrides, token) => {
      const service = mediaService(
        await startFake(overrides as Partial<FakeGraphOptions>),
        token ? { token } : {},
      );
      const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf");
      await expect(service.processMediaFile(id, log)).rejects.toThrow();
      expect(await mediaFile(id)).toMatchObject({ status: "pending", attempts: 1 });
    },
  );

  it("resetFailed puts failed media back to pending for wa:media:retry", async () => {
    const service = mediaService(await startFake({ faults: { "media-info": 404 } }));
    const id = await receiveMedia("document", SAMPLES.pdf, "application/pdf");
    await service.processMediaFile(id, log);

    expect(await createMediaRepository(prisma).resetFailed({ limit: 10 })).toEqual([id]);
    expect(await mediaFile(id)).toMatchObject({
      status: "pending",
      attempts: 0,
      rejectReason: null,
    });
  });

  describe("atomic enqueue with pg-boss fromPrisma(tx)", () => {
    it("the media job is committed together with the message", async () => {
      const enqueueMediaInTx = createEnqueueMediaInTx(boss);
      const stored = mediaStore.register(SAMPLES.pdf, { mimeType: "application/pdf" });
      const { payload } = buildInboundMessage(business, contact, {
        type: "document",
        media: { id: stored.id, mimeType: "application/pdf", sha256: stored.sha256Hex },
      });
      const event = await createWhatsAppWebhookRepository(prisma).saveEvent({
        bodySha256: stored.sha256Hex,
        payload,
      });
      if (event.duplicate) throw new Error("unexpected duplicate");
      await createWhatsAppIngestService({
        repository: createWhatsAppIngestRepository(prisma, { enqueueMediaInTx }),
        phoneNumberId: PHONE_NUMBER_ID,
      }).processEvent(event.id, log);

      const file = await prisma.mediaFile.findFirstOrThrow({ where: { waMediaId: stored.id } });
      const jobs = await boss.findJobs(QUEUES.whatsappMedia, { data: { mediaFileId: file.id } });
      expect(jobs).toHaveLength(1);
    });

    it("a rolled-back transaction leaves no job behind", async () => {
      const enqueueMediaInTx = createEnqueueMediaInTx(boss);
      const ghostId = "0199a1b2-0000-7000-8000-00000000dead";

      await expect(
        prisma.$transaction(async (tx) => {
          await enqueueMediaInTx(tx, ghostId);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const jobs = await boss.findJobs(QUEUES.whatsappMedia, { data: { mediaFileId: ghostId } });
      expect(jobs).toHaveLength(0);
    });
  });
});
