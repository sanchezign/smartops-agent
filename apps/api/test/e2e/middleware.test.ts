import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/build-app.js";

describe("request-id", () => {
  it("generates an X-Request-Id when none is sent", async () => {
    const res = await request(buildTestApp()).get("/api/v1/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("propagates a safe incoming X-Request-Id", async () => {
    const res = await request(buildTestApp())
      .get("/api/v1/nope")
      .set("X-Request-Id", "abc-123.trace:1");
    expect(res.headers["x-request-id"]).toBe("abc-123.trace:1");
    expect(res.body.error.requestId).toBe("abc-123.trace:1");
  });

  it("replaces an unsafe incoming X-Request-Id", async () => {
    const res = await request(buildTestApp())
      .get("/api/v1/health")
      .set("X-Request-Id", "bad id with spaces");
    expect(res.headers["x-request-id"]).not.toBe("bad id with spaces");
  });
});

describe("body parsing", () => {
  it("returns 400 INVALID_JSON for malformed JSON", async () => {
    const res = await request(buildTestApp())
      .post("/api/v1/anything")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("returns 413 PAYLOAD_TOO_LARGE above 1mb", async () => {
    const res = await request(buildTestApp())
      .post("/api/v1/anything")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("security headers (helmet)", () => {
  it("sets the standard helmet headers", async () => {
    const res = await request(buildTestApp()).get("/api/v1/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});

describe("CORS", () => {
  it("allows a configured origin", async () => {
    const res = await request(buildTestApp())
      .get("/api/v1/health")
      .set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow an unknown origin", async () => {
    const res = await request(buildTestApp())
      .get("/api/v1/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight for a configured origin", async () => {
    const res = await request(buildTestApp())
      .options("/api/v1/health")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});

describe("rate limiting", () => {
  it("returns 429 RATE_LIMITED with the error shape once the limit is hit", async () => {
    const app = buildTestApp({ env: { RATE_LIMIT_MAX: "2" } });
    await request(app).get("/api/v1/unknown");
    await request(app).get("/api/v1/unknown");
    const res = await request(app).get("/api/v1/unknown");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("JSON serialization", () => {
  it("registers the Decimal replacer on the app", () => {
    const app = buildTestApp();
    expect(app.get("json replacer")).toBeTypeOf("function");
  });
});
