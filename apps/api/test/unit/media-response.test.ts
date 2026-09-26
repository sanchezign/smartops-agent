import { describe, expect, it } from "vitest";
import {
  baseMime,
  mediaResponseHeaders,
  safeFilename,
} from "../../src/modules/admin/media-response.js";

/** Panel media route (phase 9 M3, ADR-019): untrusted bytes are never rendered as a page. */

const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";

describe("mediaResponseHeaders", () => {
  it.each([
    ["image/jpeg", "image/jpeg"],
    ["audio/ogg; codecs=opus", "audio/ogg"],
    ["application/pdf", "application/pdf"],
  ])("%s is served inline as %s", (mime, contentType) => {
    const h = mediaResponseHeaders({ id: ID, mimeType: mime, filename: null, size: 10 });
    expect(h["content-type"]).toBe(contentType);
    expect(h["content-disposition"]).toMatch(/^inline;/);
  });

  it.each([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "text/plain",
    "text/html",
    "image/svg+xml",
  ])("%s is an attachment with application/octet-stream (never rendered)", (mime) => {
    const h = mediaResponseHeaders({ id: ID, mimeType: mime, filename: "x", size: 1 });
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["content-disposition"]).toMatch(/^attachment;/);
  });

  it("always sends nosniff, a sandbox CSP, no-store and the exact length", () => {
    const h = mediaResponseHeaders({ id: ID, mimeType: "image/png", filename: null, size: 1234 });
    expect(h).toMatchObject({
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "content-length": "1234",
    });
  });

  it("filenames cannot break the header (quotes, CR/LF, paths) and keep UTF-8 via filename*", () => {
    const h = mediaResponseHeaders({
      id: ID,
      mimeType: "application/pdf",
      filename: '..\\..\\Lista "año"\r\nSet-Cookie: x=1.pdf',
      size: 1,
    });
    const disposition = h["content-disposition"]!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain(`filename="Lista a_oSet-Cookie: x=1.pdf"`);
    expect(disposition).toContain(`filename*=UTF-8''Lista%20a%C3%B1oSet-Cookie%3A%20x%3D1.pdf`);
  });
});

describe("safeFilename / baseMime", () => {
  it("falls back to a generated name with the right extension", () => {
    expect(safeFilename(null, "audio/ogg; codecs=opus", ID)).toBe("archivo-01a0dc63.ogg");
    expect(safeFilename("  ", "application/zip", ID)).toBe("archivo-01a0dc63");
    expect(safeFilename("dir/sub/lista.xlsx", "x", ID)).toBe("lista.xlsx");
  });

  it("drops mime parameters and case", () => {
    expect(baseMime("Audio/OGG; codecs=opus")).toBe("audio/ogg");
  });
});
