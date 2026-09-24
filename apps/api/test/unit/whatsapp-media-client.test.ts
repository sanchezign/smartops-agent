import { describe, expect, it } from "vitest";
import { isAllowedDownloadUrl } from "../../src/modules/whatsapp/whatsapp-media.client.js";

describe("isAllowedDownloadUrl (where the access token may be sent)", () => {
  const prod = { graphBaseUrl: "https://graph.facebook.com", production: true };
  const dev = { graphBaseUrl: "http://localhost:4010", production: false };

  it.each([
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=2&hash=3",
    "https://graph.facebook.com/v26.0/123/download",
    "https://scontent.xx.fbsbx.com/v/t1/abc",
  ])("allows Meta HTTPS hosts in production: %s", (url) => {
    expect(isAllowedDownloadUrl(url, prod)).toBe(true);
  });

  it.each([
    "http://lookaside.fbsbx.com/x", // no TLS
    "https://evil.example.com/x",
    "https://fbsbx.com.evil.example/x",
    "https://lookaside.fbsbx.com.evil.example/x",
    "http://localhost:4010/media-download/1",
    "not a url",
  ])("refuses in production: %s", (url) => {
    expect(isAllowedDownloadUrl(url, prod)).toBe(false);
  });

  it("allows the configured fake Graph API host outside production only", () => {
    expect(isAllowedDownloadUrl("http://localhost:4010/media-download/1?exp=1&sig=x", dev)).toBe(
      true,
    );
    expect(isAllowedDownloadUrl("http://localhost:9999/media-download/1", dev)).toBe(false);
    expect(isAllowedDownloadUrl("http://127.0.0.1:4010/media-download/1", dev)).toBe(false);
    expect(isAllowedDownloadUrl("https://lookaside.fbsbx.com/x", dev)).toBe(true);
  });
});
