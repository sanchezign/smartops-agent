import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { MediaStorage } from "../../src/modules/media/media-storage.js";
import {
  TranscriptionError,
  type Transcriber,
} from "../../src/modules/transcription/transcriber.js";
import type {
  TranscriptionForProcessing,
  TranscriptionRepository,
} from "../../src/modules/transcription/transcription.repository.js";
import { createTranscriptionService } from "../../src/modules/transcription/transcription.service.js";
import { SAMPLES } from "../helpers/media-samples.js";

const SECRET_TEXT = "El tornillo de seis milímetros sube a catorce pesos";

function setup(options: {
  item?: Partial<TranscriptionForProcessing> | null;
  usedToday?: number;
  bytes?: Uint8Array | null;
  transcribe?: () => Promise<Awaited<ReturnType<Transcriber["transcribe"]>>>;
  supports?: boolean;
  maxSeconds?: number;
}) {
  const final: { status: string; reason: string }[] = [];
  const done: { text: string }[] = [];
  const repository: TranscriptionRepository = {
    getForProcessing: vi.fn(async () =>
      options.item === null
        ? null
        : {
            mediaFileId: "mf-1",
            status: "pending" as const,
            mimeType: "audio/ogg; codecs=opus",
            mediaStatus: "stored" as const,
            messageId: "m-1",
            contactId: "c-1",
            ...options.item,
          },
    ),
    incrementAttempts: vi.fn(async () => {}),
    countDoneForContactSince: vi.fn(async () => options.usedToday ?? 0),
    markDone: vi.fn(async (_id, input) => {
      done.push(input);
    }),
    markFinal: vi.fn(async (_id, status, reason) => {
      final.push({ status, reason });
    }),
    recordError: vi.fn(async () => {}),
    resetFailed: vi.fn(async () => []),
    markTooLong: vi.fn(async () => {}),
  };
  const storage: MediaStorage = {
    kind: "postgres",
    put: vi.fn(async () => {}),
    get: vi.fn(async () => (options.bytes === undefined ? SAMPLES.ogg : options.bytes)),
  };
  const transcriber: Transcriber = {
    provider: "groq",
    model: "whisper-large-v3",
    supports: vi.fn(() => options.supports ?? true),
    transcribe: vi.fn(
      options.transcribe ??
        (async () => ({
          text: SECRET_TEXT,
          provider: "groq" as const,
          model: "whisper-large-v3",
          language: "es",
          durationSeconds: 4.2,
          latencyMs: 350,
        })),
    ),
  };
  const onTranscribed = vi.fn(async () => {});
  const service = createTranscriptionService({
    repository,
    storage,
    transcriber,
    language: "es",
    prompt: "lista de precios",
    dailyLimitPerContact: 3,
    onTranscribed,
    ...(options.maxSeconds !== undefined
      ? { maxAutoDurationSeconds: async () => options.maxSeconds! }
      : {}),
  });
  return { service, repository, transcriber, final, done, onTranscribed };
}

function captureLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { log: pino({ level: "trace" }, sink), lines };
}

describe("transcription service", () => {
  it("transcribes with language + vocabulary prompt, stores the result and calls the hook", async () => {
    const { service, transcriber, done, onTranscribed } = setup({});
    const { log, lines } = captureLogger();

    expect(await service.processTranscription("mf-1", log)).toEqual({ outcome: "done" });
    expect(transcriber.transcribe).toHaveBeenCalledWith({
      bytes: SAMPLES.ogg,
      mimeType: "audio/ogg; codecs=opus",
      language: "es",
      prompt: "lista de precios",
    });
    expect(done[0]).toMatchObject({
      text: SECRET_TEXT,
      provider: "groq",
      model: "whisper-large-v3",
      durationSeconds: 4.2,
      latencyMs: 350,
    });
    expect(onTranscribed).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m-1" }));
    // Personal data: the transcript never reaches the logs (only its length).
    const logs = lines.join("");
    expect(logs).not.toContain("tornillo");
    expect(logs).toContain(`"chars":${SECRET_TEXT.length}`);
  });

  it("is idempotent: a transcription no longer pending is skipped", async () => {
    const { service, transcriber } = setup({ item: { status: "done" } });
    expect((await service.processTranscription("mf-1", captureLogger().log)).outcome).toBe(
      "already_done",
    );
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("skips formats the provider does not accept (aac/amr)", async () => {
    const { service, transcriber } = setup({ supports: false, item: { mimeType: "audio/aac" } });
    expect(await service.processTranscription("mf-1", captureLogger().log)).toEqual({
      outcome: "skipped",
      reason: "unsupported_format",
    });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("skips when the contact reached its daily limit", async () => {
    const { service, transcriber } = setup({ usedToday: 3 });
    expect(await service.processTranscription("mf-1", captureLogger().log)).toEqual({
      outcome: "skipped",
      reason: "quota_exceeded",
    });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("fails (no retry) when the audio bytes are missing", async () => {
    const { service } = setup({ bytes: null });
    expect((await service.processTranscription("mf-1", captureLogger().log)).reason).toBe(
      "media_missing",
    );
  });

  it("fails permanently when the provider rejects the audio", async () => {
    const { service, final } = setup({
      transcribe: async () => {
        throw new TranscriptionError("invalid_audio", false, "HTTP 400: invalid file", 400);
      },
    });
    expect(await service.processTranscription("mf-1", captureLogger().log)).toEqual({
      outcome: "failed",
      reason: "invalid_audio",
    });
    expect(final).toEqual([{ status: "failed", reason: "invalid_audio" }]);
  });

  it.each([
    ["rate limit", new TranscriptionError("rate_limited", true, "429", 429, 12)],
    ["bad key", new TranscriptionError("unauthorized", true, "401", 401)],
    ["timeout", new TranscriptionError("timeout", true, "timed out")],
  ])("throws on %s so pg-boss retries (nothing finalized)", async (_label, error) => {
    const { service, final, done } = setup({
      transcribe: async () => {
        throw error;
      },
    });
    await expect(service.processTranscription("mf-1", captureLogger().log)).rejects.toBe(error);
    expect(final).toEqual([]);
    expect(done).toEqual([]);
  });
});
