import { readdirSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { signWhatsAppBody } from "../../src/modules/whatsapp/whatsapp-signature.js";
import {
  buildTestApp,
  stubInternalDeps,
  TEST_INTERNAL_API_KEY,
  TEST_JWT_ACCESS_SECRET,
  TEST_WHATSAPP_APP_SECRET,
  TEST_WHATSAPP_ENV,
  TEST_WHATSAPP_VERIFY_TOKEN,
} from "../helpers/build-app.js";
import { whatsappFixture } from "../helpers/fixtures.js";
import {
  createCaptureLogger,
  digitRunsInStrings,
  sensitiveFixtureValues,
} from "../helpers/log-capture.js";

/**
 * No log line carries a secret or a full phone number — including the ERROR paths (phase 10
 * M6, user addendum C). The API is driven through every door a secret can come in by
 * (Authorization, cookies, the internal key, Meta's signature and verify token, passwords in
 * bodies, malformed bodies, oversized bodies, rate limits, a crashing handler) with the
 * PRODUCTION logger factory at level "trace", and every captured line is searched.
 * The worker side (webhook processing with real payloads) is log-safety-worker.test.ts.
 */

const FIXTURES = new URL("../fixtures/whatsapp/", import.meta.url);
const PASSWORD = "una frase secreta larguísima 4815";
const BEARER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2VjcmV0LXNpZ25hdHVyZS14eXo";
const REFRESH = "rEfReShToKeN0123456789abcdefghijklmnopqrstu";

describe("log safety (API)", () => {
  it("no secret, password, token or full phone number in any log line", async () => {
    const { logger, lines } = createCaptureLogger();
    const app = buildTestApp({
      logger,
      env: { LOG_LEVEL: "trace", RATE_LIMIT_MAX: "25", LOGIN_RATE_LIMIT_MAX: "2" },
      internal: {
        ...stubInternalDeps,
        ingestion: {
          ...stubInternalDeps.ingestion,
          // A crashing handler (5xx path): its error is logged with the stack.
          classify: async () => {
            throw new Error("database exploded");
          },
        },
      },
    });
    const csrf = { "x-smartops-csrf": "1", origin: "http://localhost:3000" };

    // Passwords in bodies (login ×3 → the login limiter kicks in) and a malformed body.
    for (let i = 0; i < 3; i += 1)
      await request(app)
        .post("/api/v1/auth/login")
        .set(csrf)
        .send({ email: "ana@x.uy", password: PASSWORD });
    await request(app)
      .post("/api/v1/auth/login")
      .set(csrf)
      .set("content-type", "application/json")
      .send(`{"email":"ana@x.uy","password":"${PASSWORD}"`); // broken JSON
    // Tokens in headers and cookies.
    await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${BEARER}`);
    await request(app).get("/api/v1/admin/reviews").set("authorization", `Bearer ${BEARER}`);
    await request(app)
      .post("/api/v1/auth/refresh")
      .set(csrf)
      .set("cookie", `__Secure-smartops_refresh=${REFRESH}; smartops_refresh=${REFRESH}`);
    await request(app).post("/api/v1/events").set("authorization", `Bearer ${BEARER}`);
    // The internal key: wrong, right + invalid body, right + crashing handler.
    await request(app)
      .post("/api/v1/internal/classify")
      .set("x-internal-api-key", "a-wrong-key-guess-1234567890");
    await request(app)
      .post("/api/v1/internal/classify")
      .set("x-internal-api-key", TEST_INTERNAL_API_KEY)
      .send({});
    await request(app)
      .post("/api/v1/internal/classify")
      .set("x-internal-api-key", TEST_INTERNAL_API_KEY)
      .send({ messageId: "01a0dc63-e4b1-716c-a982-fbceaa90e2ba" });
    // Meta: verification with the right and a wrong token, signed and badly signed deliveries.
    for (const token of [TEST_WHATSAPP_VERIFY_TOKEN, "not-the-verify-token-999"])
      await request(app)
        .get("/api/v1/webhooks/whatsapp")
        .query({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" });
    for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".json"))) {
      const body = whatsappFixture(name.replace(/\.json$/, ""));
      await request(app)
        .post("/api/v1/webhooks/whatsapp")
        .set("content-type", "application/json")
        .set("x-hub-signature-256", signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET))
        .send(body);
    }
    const one = whatsappFixture("message-text");
    await request(app)
      .post("/api/v1/webhooks/whatsapp")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", `sha256=${"0".repeat(64)}`)
      .send(one);
    await request(app)
      .post("/api/v1/webhooks/whatsapp")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", signWhatsAppBody(one, "a-wrong-app-secret"))
      .send(one);
    // Oversized body (413) and the global limiter (429).
    await request(app)
      .post("/api/v1/auth/login")
      .set(csrf)
      .send({ password: PASSWORD, pad: "x".repeat(200_000) });
    for (let i = 0; i < 30; i += 1)
      await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${BEARER}`);

    // Not vacuous: the doors above were really logged, errors included.
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(60);
    expect(all).toContain('"statusCode":429');
    expect(all).toContain('"statusCode":500');
    expect(all).toContain("database exploded");
    expect(all).toContain("[redacted]");

    const secrets = [
      PASSWORD,
      BEARER,
      REFRESH,
      TEST_INTERNAL_API_KEY,
      TEST_JWT_ACCESS_SECRET,
      TEST_WHATSAPP_APP_SECRET,
      TEST_WHATSAPP_VERIFY_TOKEN,
      TEST_WHATSAPP_ENV.WHATSAPP_ACCESS_TOKEN,
      "a-wrong-key-guess-1234567890",
      "not-the-verify-token-999",
    ];
    const leaks = [...secrets, ...sensitiveFixtureValues()].filter((s) => all.includes(s));
    expect(leaks).toEqual([]);
    // Any 10+ digit run inside a STRING value is a phone that escaped masking (pino's numeric
    // `time` is a number, ids are UUIDs).
    expect(digitRunsInStrings(lines)).toEqual([]);
  });

  it("the fixtures really contain what the check looks for (phones, texts, media URLs)", () => {
    const values = sensitiveFixtureValues();
    expect(values.some((v) => /^\d{10,}$/.test(v))).toBe(true);
    expect(values.some((v) => v.startsWith("https://"))).toBe(true);
    expect(values.some((v) => /[a-záéíóú]{4,}/i.test(v) && !v.startsWith("http"))).toBe(true);
  });
});
