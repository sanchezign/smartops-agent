import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { parseEnv } from "../../src/config/env.js";
import { signWhatsAppBody } from "../../src/modules/whatsapp/whatsapp-signature.js";
import {
  buildTestApp,
  createInMemoryWebhookRepository,
  healthyDb,
  TEST_ENV_SOURCE,
  TEST_WHATSAPP_APP_SECRET,
  TEST_WHATSAPP_VERIFY_TOKEN,
} from "../helpers/build-app.js";
import { whatsappFixture } from "../helpers/fixtures.js";

const URL = "/api/v1/webhooks/whatsapp";

function post(app: ReturnType<typeof buildTestApp>, body: Buffer, signature?: string) {
  const req = request(app).post(URL).set("Content-Type", "application/json");
  if (signature !== undefined) req.set("X-Hub-Signature-256", signature);
  // superagent JSON.stringify()s Buffers when Content-Type is json: send the exact UTF-8 text.
  return req.send(body.toString("utf8"));
}

describe("GET /api/v1/webhooks/whatsapp (verification)", () => {
  it("echoes hub.challenge as plain text when the verify token matches", async () => {
    const res = await request(buildTestApp()).get(URL).query({
      "hub.mode": "subscribe",
      "hub.verify_token": TEST_WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toBe("1158201444");
  });

  it("returns 403 for a wrong verify token", async () => {
    const res = await request(buildTestApp()).get(URL).query({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token-000000000",
      "hub.challenge": "1",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 when hub.mode is not subscribe", async () => {
    const res = await request(buildTestApp()).get(URL).query({
      "hub.mode": "unsubscribe",
      "hub.verify_token": TEST_WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "1",
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the hub params are missing", async () => {
    const res = await request(buildTestApp()).get(URL);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/v1/webhooks/whatsapp", () => {
  it("stores a correctly signed delivery with its body hash and acks 200", async () => {
    const repository = createInMemoryWebhookRepository();
    const body = whatsappFixture("status-failed");

    const res = await post(
      buildTestApp({ whatsappWebhookRepository: repository }),
      body,
      signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET),
    );

    expect(res.status).toBe(200);
    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]?.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(repository.events[0]?.payload).toEqual(JSON.parse(body.toString("utf8")));
  });

  it("acks 200 but stores an identical re-delivery only once", async () => {
    const repository = createInMemoryWebhookRepository();
    const app = buildTestApp({ whatsappWebhookRepository: repository });
    const body = whatsappFixture("message-text");
    const signature = signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET);

    expect((await post(app, body, signature)).status).toBe(200);
    expect((await post(app, body, signature)).status).toBe(200);
    expect(repository.events).toHaveLength(1);
  });

  it("returns 401 and stores nothing for an invalid signature", async () => {
    const repository = createInMemoryWebhookRepository();
    const body = whatsappFixture("message-text");

    const res = await post(
      buildTestApp({ whatsappWebhookRepository: repository }),
      body,
      signWhatsAppBody(body, "not-the-app-secret"),
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(repository.events).toHaveLength(0);
  });

  it("returns 401 when the signature header is missing", async () => {
    const repository = createInMemoryWebhookRepository();
    const res = await post(
      buildTestApp({ whatsappWebhookRepository: repository }),
      whatsappFixture("message-text"),
    );
    expect(res.status).toBe(401);
    expect(repository.events).toHaveLength(0);
  });

  it("verifies over the raw bytes: a re-serialized body fails", async () => {
    const original = whatsappFixture("message-text");
    const compact = Buffer.from(JSON.stringify(JSON.parse(original.toString("utf8"))));
    const res = await post(
      buildTestApp(),
      compact,
      signWhatsAppBody(original, TEST_WHATSAPP_APP_SECRET),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for a non-JSON content type", async () => {
    const res = await request(buildTestApp())
      .post(URL)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a signed body that is not a JSON object", async () => {
    const body = Buffer.from("[1,2,3]");
    const res = await post(buildTestApp(), body, signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET));
    expect(res.status).toBe(400);
  });

  it("is not affected by the 1mb express.json limit (Meta sends up to 3 MB)", async () => {
    const body = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [],
        pad: "x".repeat(1_500_000),
      }),
    );
    const res = await post(buildTestApp(), body, signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET));
    expect(res.status).toBe(200);
  });

  it("logs the Meta error code of a failed status with the phone number masked", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const env = parseEnv({ ...TEST_ENV_SOURCE, LOG_LEVEL: "info" });
    const app = createApp({
      env,
      logger: pino({ level: "info" }, sink),
      healthRepository: healthyDb,
      whatsappWebhookRepository: createInMemoryWebhookRepository(),
    });
    const body = whatsappFixture("status-failed");

    const res = await post(app, body, signWhatsAppBody(body, TEST_WHATSAPP_APP_SECRET));
    expect(res.status).toBe(200);

    const logs = lines.join("");
    const failed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === "whatsapp status: failed");
    expect(failed).toMatchObject({
      level: 40,
      wamid: "wamid.TEST_FAILED_0001",
      recipient: "598*****111",
      errors: [expect.objectContaining({ code: 131030 })],
    });
    expect(logs).not.toContain("59899000111");
  });
});
