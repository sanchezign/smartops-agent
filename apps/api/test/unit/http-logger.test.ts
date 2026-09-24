import { describe, expect, it } from "vitest";
import { redactUrl } from "../../src/common/middleware/http-logger.js";

describe("redactUrl", () => {
  it("redacts the webhook verify token and keeps other params", () => {
    expect(
      redactUrl(
        "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=s3cret&hub.challenge=42",
      ),
    ).toBe(
      "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=42",
    );
  });

  it("redacts the URL-encoded variant", () => {
    expect(redactUrl("/x?hub%2Everify_token=s3cret")).toBe("/x?hub%2Everify_token=[redacted]");
  });

  it("leaves URLs without sensitive params unchanged", () => {
    expect(redactUrl("/api/v1/health?verbose=1")).toBe("/api/v1/health?verbose=1");
  });
});
