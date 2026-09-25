import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  hasPriceSignal,
  prefilter,
  type PrefilterInput,
} from "../../src/modules/extraction/prefilter.js";
import { audioDurationSeconds } from "../../src/modules/media/audio-duration.js";
import type { MediaStorage } from "../../src/modules/media/media-storage.js";
import type { Transcriber } from "../../src/modules/transcription/transcriber.js";
import type { TranscriptionRepository } from "../../src/modules/transcription/transcription.repository.js";
import { createTranscriptionService } from "../../src/modules/transcription/transcription.service.js";

const log = pino({ level: "silent" });

const base: PrefilterInput = {
  messageType: "text",
  contactKind: "supplier",
  text: null,
  transcript: null,
  mediaStatus: null,
  transcriptionStatus: null,
  transcriptionReason: null,
};

describe("pre-filter (no LLM for obvious messages)", () => {
  it.each(["hola", "gracias!!", "ok", "👍🙏", "buen día, cómo andás?", "dale, te aviso"])(
    "short text without price signals → other: %j",
    (text) => {
      expect(prefilter({ ...base, text })).toMatchObject({
        rule: "no_price_signal",
        classification: "other",
      });
    },
  );

  it.each([
    "Tarugo 8mm 150",
    "la cinta sube a 110",
    "todo +8%",
    "no hay más bisagras",
    "te paso la lista nueva",
    "precios en U$S",
    "quedó agotado el pegamento",
    "sube un 10 por ciento",
  ])("anything that can be a price list goes on to the classifier: %j", (text) => {
    expect(prefilter({ ...base, text })).toBeNull();
  });

  it("customers never go to price extraction: customer_query without LLM", () => {
    expect(
      prefilter({ ...base, contactKind: "customer", text: "¿cuánto sale el candado?" }),
    ).toMatchObject({
      rule: "customer_contact",
      classification: "customer_query",
    });
    // Even a document from a customer.
    expect(
      prefilter({
        ...base,
        contactKind: "customer",
        messageType: "document",
        mediaStatus: "stored",
      }),
    ).toMatchObject({ rule: "customer_contact" });
  });

  it.each(["sticker", "reaction", "location", "contacts", "unsupported", "interactive", "video"])(
    "type %s → other",
    (messageType) => {
      expect(prefilter({ ...base, messageType })).toMatchObject({ rule: "non_content_type" });
    },
  );

  it("media that could not be stored → other; stored images/PDFs/spreadsheets go on", () => {
    expect(prefilter({ ...base, messageType: "image", mediaStatus: "rejected" })).toMatchObject({
      rule: "media_unavailable",
    });
    for (const messageType of ["image", "document"])
      expect(prefilter({ ...base, messageType, mediaStatus: "stored" })).toBeNull();
  });

  it("voice notes: too long / not transcribed → other; a transcript is filtered like text", () => {
    const audio = { ...base, messageType: "audio", mediaStatus: "stored" };
    expect(
      prefilter({ ...audio, transcriptionStatus: "skipped", transcriptionReason: "too_long" }),
    ).toMatchObject({ rule: "audio_too_long" });
    expect(
      prefilter({
        ...audio,
        transcriptionStatus: "skipped",
        transcriptionReason: "quota_exceeded",
      }),
    ).toMatchObject({ rule: "audio_not_transcribed" });
    expect(
      prefilter({ ...audio, transcriptionStatus: "done", transcript: "hola, ¿cómo va?" }),
    ).toMatchObject({
      rule: "no_price_signal",
    });
    expect(
      prefilter({ ...audio, transcriptionStatus: "done", transcript: "el candado sube a 320" }),
    ).toBeNull();
  });

  it("price signals are conservative (digits, currency, price and stock words)", () => {
    expect(hasPriceSignal("sin stock")).toBe(true);
    expect(hasPriceSignal("aumentaron")).toBe(true);
    expect(hasPriceSignal("nos vemos mañana")).toBe(false);
  });
});

/** Minimal OGG/Opus file: OpusHead page + last page with the granule position. */
function oggOpus(seconds: number, preSkip = 312): Uint8Array {
  const page = (granule: bigint, payload: number[]) => {
    const header = new Uint8Array(27 + payload.length);
    header.set(
      [..."OggS"].map((c) => c.charCodeAt(0)),
      0,
    );
    new DataView(header.buffer).setBigInt64(6, granule, true);
    header.set(payload, 27);
    return header;
  };
  const opusHead = [..."OpusHead"]
    .map((c) => c.charCodeAt(0))
    .concat([1, 1, preSkip & 0xff, preSkip >> 8]);
  const first = page(0n, opusHead);
  const last = page(BigInt(Math.round(seconds * 48_000) + preSkip), [0, 0, 0]);
  const out = new Uint8Array(first.length + 1000 + last.length);
  out.set(first, 0);
  out.set(last, first.length + 1000);
  return out;
}

/** Minimal MP4 with an mvhd box (version 0). */
function mp4(seconds: number, timescale = 1000): Uint8Array {
  const box = new Uint8Array(40);
  box.set(
    [..."mvhd"].map((c) => c.charCodeAt(0)),
    4,
  );
  const view = new DataView(box.buffer);
  box[8] = 0; // version
  view.setUint32(8 + 4 + 8, timescale, false);
  view.setUint32(8 + 4 + 12, Math.round(seconds * timescale), false);
  return box;
}

describe("audio duration without ffmpeg", () => {
  it("OGG/Opus: last granule minus pre-skip at 48 kHz", () => {
    expect(audioDurationSeconds(oggOpus(7.42), "audio/ogg; codecs=opus")).toBeCloseTo(7.42, 2);
    expect(audioDurationSeconds(oggOpus(250), "audio/ogg")).toBeCloseTo(250, 2);
  });

  it("MP4/M4A: mvhd duration / timescale", () => {
    expect(audioDurationSeconds(mp4(95.5), "audio/mp4")).toBeCloseTo(95.5, 2);
  });

  it("unknown formats or broken files → null", () => {
    expect(audioDurationSeconds(new Uint8Array([1, 2, 3]), "audio/ogg")).toBeNull();
    expect(audioDurationSeconds(new Uint8Array(10), "audio/mpeg")).toBeNull();
  });
});

describe("transcription duration cap (Setting transcription.maxAutoDurationSeconds)", () => {
  function service(bytes: Uint8Array, mimeType: string, maxSeconds = 180) {
    const repository = {
      getForProcessing: vi.fn(async () => ({
        mediaFileId: "mf-1",
        status: "pending" as const,
        mimeType,
        mediaStatus: "stored" as const,
        messageId: "m-1",
        contactId: "c-1",
      })),
      incrementAttempts: vi.fn(async () => {}),
      countDoneForContactSince: vi.fn(async () => 0),
      markDone: vi.fn(async () => {}),
      markFinal: vi.fn(async () => {}),
      markTooLong: vi.fn(async () => {}),
      recordError: vi.fn(async () => {}),
      resetFailed: vi.fn(async () => []),
    } satisfies TranscriptionRepository;
    const storage: MediaStorage = { kind: "postgres", put: vi.fn(), get: vi.fn(async () => bytes) };
    const transcriber: Transcriber = {
      provider: "groq",
      model: "whisper-large-v3",
      supports: () => true,
      transcribe: vi.fn(async () => ({
        text: "hola",
        provider: "groq" as const,
        model: "whisper-large-v3",
        language: "es",
        durationSeconds: 1,
        latencyMs: 1,
      })),
    };
    return {
      repository,
      transcriber,
      svc: createTranscriptionService({
        repository,
        storage,
        transcriber,
        language: "es",
        dailyLimitPerContact: 50,
        maxAutoDurationSeconds: async () => maxSeconds,
      }),
    };
  }

  it("a 4-minute voice note is not sent to the provider: skipped too_long + manual attention", async () => {
    const { svc, repository, transcriber } = service(oggOpus(240), "audio/ogg; codecs=opus");
    expect(await svc.processTranscription("mf-1", log)).toEqual({
      outcome: "skipped",
      reason: "too_long",
    });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(repository.markTooLong).toHaveBeenCalledWith("mf-1", {
      durationSeconds: expect.closeTo(240, 1),
      sizeBytes: expect.any(Number),
      maxSeconds: 180,
    });
  });

  it("a 2-minute note is transcribed; the limit comes from the setting", async () => {
    expect(
      (await service(oggOpus(120), "audio/ogg").svc.processTranscription("mf-1", log)).outcome,
    ).toBe("done");
    expect(
      (await service(oggOpus(120), "audio/ogg", 60).svc.processTranscription("mf-1", log)).reason,
    ).toBe("too_long");
  });

  it("unknown duration: only big files (> 3 MB) are treated as long", async () => {
    expect(
      (
        await service(new Uint8Array(4 * 1024 * 1024), "audio/mpeg").svc.processTranscription(
          "mf-1",
          log,
        )
      ).reason,
    ).toBe("too_long");
    expect(
      (await service(new Uint8Array(1024), "audio/mpeg").svc.processTranscription("mf-1", log))
        .outcome,
    ).toBe("done");
  });
});
