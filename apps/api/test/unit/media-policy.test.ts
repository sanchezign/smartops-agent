import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  contentMatchesMime,
  effectiveMaxBytes,
  normalizeMime,
  planMedia,
  sha256Matches,
} from "../../src/modules/media/media-policy.js";
import { SAMPLES } from "../helpers/media-samples.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("planMedia", () => {
  it.each([
    ["image", "image/jpeg"],
    ["image", "image/png"],
    ["audio", "audio/ogg; codecs=opus"],
    ["audio", "audio/mpeg"],
    ["audio", "audio/mp4"],
    ["document", "application/pdf"],
    ["document", XLSX],
    ["document", "application/vnd.ms-excel"],
    ["document", DOCX],
    ["document", "text/csv"],
    ["document", "text/plain"],
    ["document", "image/jpeg"], // photo sent "as document"
  ])("downloads %s %s", (type, mime) => {
    expect(planMedia(type, mime)).toEqual({ action: "download", kind: type });
  });

  it.each([["video"], ["sticker"]])("skips %s (not downloaded by design)", (type) => {
    expect(planMedia(type, "video/mp4")).toEqual({ action: "skip", reason: "type_not_downloaded" });
  });

  it.each([
    ["document", "application/x-msdownload"],
    ["document", "application/zip"],
    ["document", "application/octet-stream"],
    ["image", "application/pdf"],
    ["audio", "image/jpeg"],
    ["document", null],
  ])("rejects %s with mime %s", (type, mime) => {
    expect(planMedia(type, mime)).toEqual({ action: "reject", reason: "unsupported_mime" });
  });
});

describe("limits", () => {
  it("uses the smaller of Meta's limit and MEDIA_MAX_BYTES", () => {
    const MB = 1024 * 1024;
    expect(effectiveMaxBytes("image", 25 * MB)).toBe(5 * MB);
    expect(effectiveMaxBytes("audio", 25 * MB)).toBe(16 * MB);
    expect(effectiveMaxBytes("document", 25 * MB)).toBe(25 * MB);
    expect(effectiveMaxBytes("document", 200 * MB)).toBe(100 * MB);
  });

  it("normalizes mime types", () => {
    expect(normalizeMime("Audio/OGG; codecs=opus")).toBe("audio/ogg");
    expect(normalizeMime(undefined)).toBe("");
  });
});

describe("contentMatchesMime (magic bytes)", () => {
  it.each([
    ["application/pdf", SAMPLES.pdf],
    ["image/jpeg", SAMPLES.jpeg],
    ["image/png", SAMPLES.png],
    ["image/webp", SAMPLES.webp],
    ["audio/ogg; codecs=opus", SAMPLES.ogg],
    ["audio/mpeg", SAMPLES.mp3],
    ["audio/mp4", SAMPLES.m4a],
    ["audio/amr", SAMPLES.amr],
    [XLSX, SAMPLES.xlsx],
    ["application/vnd.ms-excel", SAMPLES.xls],
    ["text/csv", SAMPLES.csv],
  ])("accepts real %s content", (mime, bytes) => {
    expect(contentMatchesMime(mime, bytes)).toBe(true);
  });

  it.each([
    ["application/pdf", SAMPLES.exe],
    ["image/jpeg", SAMPLES.pdf],
    ["audio/ogg", SAMPLES.mp3],
    [XLSX, SAMPLES.xls],
    ["text/csv", SAMPLES.exe],
  ])("rejects %s whose content is something else", (mime, bytes) => {
    expect(contentMatchesMime(mime, bytes)).toBe(false);
  });

  it("rejects unknown mime types", () => {
    expect(contentMatchesMime("application/x-msdownload", SAMPLES.exe)).toBe(false);
  });
});

describe("sha256Matches", () => {
  const hex = createHash("sha256").update(SAMPLES.pdf).digest("hex");

  it("accepts hex (any case) and base64 declarations", () => {
    expect(sha256Matches(hex, hex)).toBe(true);
    expect(sha256Matches(hex.toUpperCase(), hex)).toBe(true);
    expect(sha256Matches(Buffer.from(hex, "hex").toString("base64"), hex)).toBe(true);
  });

  it("rejects a different hash", () => {
    const other = createHash("sha256").update("x").digest();
    expect(sha256Matches(other.toString("hex"), hex)).toBe(false);
    expect(sha256Matches(other.toString("base64"), hex)).toBe(false);
    expect(sha256Matches("not-a-hash", hex)).toBe(false);
  });

  it("accepts a missing declaration (nothing to compare)", () => {
    expect(sha256Matches(null, hex)).toBe(true);
  });
});
