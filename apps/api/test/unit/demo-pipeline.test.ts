import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { pino } from "pino";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDemoGraphRouter,
  createDemoMediaStore,
  type DemoOutbox,
} from "../../src/modules/demo/demo-graph.js";
import { createDemoInjector, DEMO_SAMPLE_KINDS } from "../../src/modules/demo/demo-injector.js";
import { audioDurationSeconds } from "../../src/modules/media/audio-duration.js";
import { contentMatchesMime, planMedia } from "../../src/modules/media/media-policy.js";
import { parseWhatsAppWebhook } from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";
import { isValidWhatsAppSignature } from "../../src/modules/whatsapp/whatsapp-signature.js";

/** Public demo pieces (phase 9 M8, ADR-021): assets, fake Graph API, injector. */

const log = pino({ level: "silent" });
const business = { phoneNumberId: "100000000000001", wabaId: "2", displayPhoneNumber: "598" };
const SECRET = "demo-app-secret-for-tests-0000000000";

afterEach(() => vi.unstubAllGlobals());

describe("demo assets", () => {
  it("the recorded outputs are the same as the test fixtures (no drift)", () => {
    const root = "test/fixtures/extraction/golden";
    for (const task of readdirSync(root)) {
      for (const file of readdirSync(join(root, task))) {
        expect(readFileSync(join("demo/golden", task, file), "utf8")).toBe(
          readFileSync(join(root, task, file), "utf8"),
        );
      }
    }
  });

  it("the voice note is a real, small Ogg/Opus (5,5 s) and keys its recorded transcript", () => {
    const ogg = new Uint8Array(readFileSync("demo/assets/nota-de-voz.ogg"));
    expect(ogg.byteLength).toBeLessThan(20_000);
    expect(contentMatchesMime("audio/ogg", ogg)).toBe(true);
    expect(planMedia("audio", "audio/ogg; codecs=opus").action).toBe("download");
    expect(audioDurationSeconds(ogg, "audio/ogg")).toBeCloseTo(5.54, 1);
    const sha = createHash("sha256").update(ogg).digest("hex");
    expect(readFileSync(join("demo/transcripts", `${sha}.txt`), "utf8")).toBe(
      readFileSync("test/fixtures/extraction/voice-transcript.txt", "utf8"),
    );
  });
});

describe("demo Graph API", () => {
  function app(outbox: DemoOutbox = { sent: [] }) {
    const store = createDemoMediaStore();
    const a = express();
    a.use(
      createDemoGraphRouter({
        store,
        outbox,
        accessToken: "tok",
        baseUrl: "http://127.0.0.1:4321",
        business,
        webhook: { url: "http://127.0.0.1:1/never", appSecret: SECRET },
        logger: log,
        statusDelayMs: 60_000,
      }),
    );
    return { app: a, store };
  }

  it("media: metadata + signed short-lived URL, Bearer required like Meta", async () => {
    const { app: a, store } = app();
    const bytes = new TextEncoder().encode("hola pdf");
    const id = store.put({ bytes, mimeType: "application/pdf", filename: "x.pdf" });
    expect((await request(a).get(`/v26.0/${id}`)).status).toBe(401);
    const info = await request(a).get(`/v26.0/${id}`).set("authorization", "Bearer tok");
    expect(info.body).toMatchObject({
      mime_type: "application/pdf",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file_size: bytes.byteLength,
    });
    const url = new URL(info.body.url as string);
    expect(url.host).toBe("127.0.0.1:4321");
    const download = await request(a)
      .get(url.pathname + url.search)
      .set("authorization", "Bearer tok")
      .buffer(true);
    expect(Buffer.from(download.body as Buffer).toString()).toBe("hola pdf");
    expect(
      (
        await request(a)
          .get(url.pathname + "?exp=1&sig=x")
          .set("authorization", "Bearer tok")
      ).status,
    ).toBe(404);
    expect(
      (await request(a).get(`/v26.0/999`).set("authorization", "Bearer tok")).body.error.code,
    ).toBe(100);
  });

  it("messages: a wamid back, recorded in the demo outbox (never Meta)", async () => {
    const outbox: DemoOutbox = { sent: [] };
    const { app: a } = app(outbox);
    const res = await request(a)
      .post("/v26.0/100000000000001/messages")
      .set("authorization", "Bearer tok")
      .send({
        messaging_product: "whatsapp",
        to: "59899000000",
        type: "text",
        text: { body: "hola" },
      });
    expect(res.body.messages[0].id).toMatch(/^wamid\./);
    expect(outbox.sent).toEqual([
      { wamid: res.body.messages[0].id, to: "59899000000", type: "text" },
    ]);
  });
});

describe("demo injector", () => {
  it.each(DEMO_SAMPLE_KINDS)("%s: a signed webhook the production parser accepts", async (kind) => {
    const posted: { body: string; signature: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        posted.push({
          body: init.body as string,
          signature: (init.headers as Record<string, string>)["x-hub-signature-256"]!,
        });
        return new Response("ok", { status: 200 });
      }),
    );
    const store = createDemoMediaStore();
    const injector = createDemoInjector({
      assetsDir: "demo",
      store,
      business,
      webhook: { url: "http://127.0.0.1:4321/api/v1/webhooks/whatsapp", appSecret: SECRET },
      logger: log,
    });
    const { wamid } = await injector.inject(kind);
    expect(
      isValidWhatsAppSignature(Buffer.from(posted[0]!.body), posted[0]!.signature, SECRET),
    ).toBe(true);
    const parsed = parseWhatsAppWebhook(JSON.parse(posted[0]!.body));
    if (!parsed.recognized) throw new Error("not recognized");
    const change = parsed.changes[0]!;
    expect(change.invalidItems).toEqual([]);
    expect(change.phoneNumberId).toBe(business.phoneNumberId);
    const message = change.messages[0]!;
    expect(message.waMessageId).toBe(wamid);
    expect(message.fromWaId).toMatch(/^59899400/);
    if (message.media) {
      const stored = store.get(message.media.waMediaId)!;
      // The declared sha256 (base64, like Meta's webhook) matches the served bytes.
      expect(message.media.sha256).toBe(createHash("sha256").update(stored.bytes).digest("base64"));
    }
  });
});

describe("/api/v1/demo routes", () => {
  it("exist only in DEMO_MODE: /info is public there, the rest needs a login", async () => {
    const { buildTestApp, stubAuthService } = await import("../helpers/build-app.js");
    const { createDemoRouter } = await import("../../src/modules/demo/demo.routes.js");
    const plain = buildTestApp();
    expect((await request(plain).get("/api/v1/demo/info")).status).toBe(404);

    const inject = vi.fn(async () => ({ wamid: "wamid.X" }));
    const demoApp = buildTestApp({
      demo: {
        graphRouter: express.Router(),
        router: createDemoRouter({
          operator: { email: "demo@x.demo", password: "clave pública de la demo" },
          injector: { inject },
          trace: { byWamid: async () => ({ received: false as const }) },
          reset: { reset: vi.fn(), nextResetAt: () => null, start: vi.fn(), stop: vi.fn() },
          auth: stubAuthService,
          rateLimit: { windowMs: 60_000, injectMax: 5, resetMax: 1 },
          logger: log,
        }),
      },
    });
    const info = await request(demoApp).get("/api/v1/demo/info");
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ demoMode: true, operator: { email: "demo@x.demo" } });
    expect((await request(demoApp).post("/api/v1/demo/inject").send({ kind: "foto" })).status).toBe(
      401,
    );
    expect((await request(demoApp).post("/api/v1/demo/reset")).status).toBe(401);
    expect((await request(demoApp).get("/api/v1/demo/trace/wamid.ABCDEFGHIJ")).status).toBe(401);
    expect(inject).not.toHaveBeenCalled();
  });
});

describe("demoUuid (stable ids of seeded rows)", () => {
  it("valid UUIDs, stable per key, different per key", async () => {
    const { demoUuid } = await import("../../src/modules/demo/demo-seed.js");
    const { z } = await import("zod");
    const a = demoUuid("conversation:59899200002");
    expect(z.uuid().safeParse(a).success).toBe(true);
    expect(demoUuid("conversation:59899200002")).toBe(a);
    expect(demoUuid("conversation:59899200003")).not.toBe(a);
  });
});
