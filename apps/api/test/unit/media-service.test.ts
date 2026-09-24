import { createHash } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { MediaStorage } from "../../src/modules/media/media-storage.js";
import type {
  MediaFileForDownload,
  MediaRepository,
} from "../../src/modules/media/media.repository.js";
import { createMediaDownloadService } from "../../src/modules/media/media.service.js";
import {
  MediaDownloadError,
  type MediaInfo,
  type WhatsAppMediaClient,
} from "../../src/modules/whatsapp/whatsapp-media.client.js";
import { SAMPLES } from "../helpers/media-samples.js";

const log = pino({ level: "silent" });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function file(overrides: Partial<MediaFileForDownload> = {}): MediaFileForDownload {
  return {
    id: "mf-1",
    waMediaId: "9000000000000001",
    mimeType: "application/pdf",
    sha256: null,
    status: "pending",
    messageType: "document",
    ...overrides,
  };
}

function setup(options: {
  file?: MediaFileForDownload | null;
  info?: Partial<MediaInfo> | Error | (() => MediaInfo | never);
  download?: Uint8Array | Error | (() => Uint8Array | never);
  maxBytes?: number;
}) {
  const final: { status: string; reason: string }[] = [];
  const stored: { mimeType: string; sizeBytes: number; contentSha256: string }[] = [];
  const blobs = new Map<string, Uint8Array>();

  const repository: MediaRepository = {
    getForDownload: vi.fn(async () => (options.file === undefined ? file() : options.file)),
    incrementAttempts: vi.fn(async () => {}),
    markStored: vi.fn(async (_id, input) => {
      stored.push(input);
    }),
    markFinal: vi.fn(async (_id, status, reason) => {
      final.push({ status, reason });
    }),
    recordError: vi.fn(async () => {}),
    resetFailed: vi.fn(async () => []),
  };
  const storage: MediaStorage = {
    kind: "postgres",
    put: vi.fn(async (id, bytes) => {
      blobs.set(id, bytes);
    }),
    get: vi.fn(async (id) => blobs.get(id) ?? null),
  };
  const defaultBytes = SAMPLES.pdf;
  const client: WhatsAppMediaClient = {
    getMediaInfo: vi.fn(async () => {
      const info = options.info;
      if (info instanceof Error) throw info;
      if (typeof info === "function") return info();
      return {
        url: "https://lookaside.fbsbx.com/x",
        mimeType: "application/pdf",
        sha256: sha(defaultBytes),
        fileSize: defaultBytes.length,
        ...info,
      };
    }),
    download: vi.fn(async () => {
      const d = options.download;
      if (d instanceof Error) throw d;
      const bytes = typeof d === "function" ? d() : (d ?? defaultBytes);
      return { bytes, sha256Hex: sha(bytes), contentType: null };
    }),
  };
  const onMediaStored = vi.fn(async () => {});
  const service = createMediaDownloadService({
    repository,
    storage,
    client,
    maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
    onMediaStored,
  });
  return { service, repository, client, storage, blobs, final, stored, onMediaStored };
}

describe("media download service", () => {
  it("downloads, verifies and stores a PDF, then calls the stored hook", async () => {
    const { service, blobs, stored, onMediaStored } = setup({});
    await expect(service.processMediaFile("mf-1", log)).resolves.toEqual({ outcome: "stored" });
    expect(blobs.get("mf-1")).toEqual(SAMPLES.pdf);
    expect(stored[0]).toMatchObject({
      mimeType: "application/pdf",
      sizeBytes: SAMPLES.pdf.length,
      contentSha256: sha(SAMPLES.pdf),
    });
    expect(onMediaStored).toHaveBeenCalledWith(
      expect.objectContaining({ mediaFileId: "mf-1", kind: "document" }),
    );
  });

  it("accepts Meta's sha256 in base64", async () => {
    const { service } = setup({
      info: { sha256: Buffer.from(sha(SAMPLES.pdf), "hex").toString("base64") },
    });
    expect((await service.processMediaFile("mf-1", log)).outcome).toBe("stored");
  });

  it("is idempotent: a non-pending file is not downloaded again", async () => {
    const { service, client } = setup({ file: file({ status: "stored" }) });
    expect((await service.processMediaFile("mf-1", log)).outcome).toBe("already_done");
    expect(client.getMediaInfo).not.toHaveBeenCalled();
  });

  it("returns not_found for a deleted media file", async () => {
    const { service } = setup({ file: null });
    expect((await service.processMediaFile("mf-1", log)).outcome).toBe("not_found");
  });

  it("skips video without any network call", async () => {
    const { service, client, final } = setup({
      file: file({ messageType: "video", mimeType: "video/mp4" }),
    });
    expect(await service.processMediaFile("mf-1", log)).toEqual({
      outcome: "skipped",
      reason: "type_not_downloaded",
    });
    expect(client.getMediaInfo).not.toHaveBeenCalled();
    expect(final).toEqual([{ status: "skipped", reason: "type_not_downloaded" }]);
  });

  it("rejects an unsupported declared mime without any network call", async () => {
    const { service, client } = setup({ file: file({ mimeType: "application/x-msdownload" }) });
    expect((await service.processMediaFile("mf-1", log)).reason).toBe("unsupported_mime");
    expect(client.getMediaInfo).not.toHaveBeenCalled();
  });

  it("rejects when Meta's media API reports an unsupported mime", async () => {
    const { service, client } = setup({ info: { mimeType: "application/zip" } });
    expect(await service.processMediaFile("mf-1", log)).toEqual({
      outcome: "rejected",
      reason: "unsupported_mime",
    });
    expect(client.download).not.toHaveBeenCalled();
  });

  it("rejects too-large media from metadata, before downloading", async () => {
    const { service, client } = setup({ info: { fileSize: 6 * 1024 * 1024 }, maxBytes: 5_000_000 });
    expect((await service.processMediaFile("mf-1", log)).reason).toBe("too_large");
    expect(client.download).not.toHaveBeenCalled();
  });

  it("rejects when the stream exceeds the cap", async () => {
    const { service } = setup({
      download: new MediaDownloadError("too_large", "Media exceeds 10 bytes"),
    });
    expect((await service.processMediaFile("mf-1", log)).reason).toBe("too_large");
  });

  it("rejects content that does not match its mime (an .exe labelled as PDF)", async () => {
    const { service, blobs } = setup({
      info: { sha256: sha(SAMPLES.exe) },
      download: SAMPLES.exe,
    });
    expect(await service.processMediaFile("mf-1", log)).toEqual({
      outcome: "rejected",
      reason: "content_mismatch",
    });
    expect(blobs.size).toBe(0);
  });

  it("rejects empty files", async () => {
    const { service } = setup({ info: { sha256: null }, download: new Uint8Array() });
    expect((await service.processMediaFile("mf-1", log)).reason).toBe("empty_file");
  });

  it("fails permanently (no retry) when the media id is unknown/expired", async () => {
    const { service, final } = setup({
      info: new MediaDownloadError("not_found", "Media not found or expired", 404),
    });
    expect(await service.processMediaFile("mf-1", log)).toEqual({
      outcome: "failed",
      reason: "media_not_found",
    });
    expect(final[0]?.status).toBe("failed");
  });

  it("fails permanently when the download host is not allowed", async () => {
    const { service } = setup({
      download: new MediaDownloadError("host_not_allowed", "Download URL host is not allowed"),
    });
    expect((await service.processMediaFile("mf-1", log)).reason).toBe("download_host_not_allowed");
  });

  it("gets a fresh URL once when the download URL expired", async () => {
    let calls = 0;
    const { service, client } = setup({
      download: () => {
        calls += 1;
        if (calls === 1) throw new MediaDownloadError("url_expired", "expired", 404);
        return SAMPLES.pdf;
      },
    });
    expect((await service.processMediaFile("mf-1", log)).outcome).toBe("stored");
    expect(client.getMediaInfo).toHaveBeenCalledTimes(2);
    expect(client.download).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unauthorized (token expired)", new MediaDownloadError("unauthorized", "401", 401)],
    ["timeout", new MediaDownloadError("timeout", "timed out")],
    ["HTTP 500", new MediaDownloadError("http", "HTTP 500", 500)],
    ["network", new MediaDownloadError("network", "ECONNRESET")],
  ])("throws (→ pg-boss retry) on %s", async (_label, error) => {
    const { service, final } = setup({ download: error });
    await expect(service.processMediaFile("mf-1", log)).rejects.toBe(error);
    expect(final).toEqual([]);
  });

  it("throws (→ retry) on a checksum mismatch and stores nothing", async () => {
    const { service, blobs } = setup({ info: { sha256: sha(Buffer.from("other")) } });
    await expect(service.processMediaFile("mf-1", log)).rejects.toThrow("checksum mismatch");
    expect(blobs.size).toBe(0);
  });
});
