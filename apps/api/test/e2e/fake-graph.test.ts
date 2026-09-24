import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeGraph,
  type FakeGraph,
  type FakeGraphOptions,
} from "../../scripts/simulator/fake-graph.js";
import { createMediaStore, type MediaStore } from "../../scripts/simulator/media-store.js";
import {
  graphRequest,
  GraphApiError,
  type GraphApiConfig,
} from "../../src/modules/whatsapp/graph-api.js";
import { isValidWhatsAppSignature } from "../../src/modules/whatsapp/whatsapp-signature.js";
import { parseWhatsAppWebhook } from "../../src/modules/whatsapp/whatsapp-webhook.parser.js";

/**
 * The fake Graph API is exercised with the PRODUCTION Graph client (graph-api.ts) —
 * proves the client works unchanged when WHATSAPP_GRAPH_BASE_URL points at the fake.
 */

const TOKEN = "EAAfake-token-for-tests-000";
const SECRET = "fake-graph-app-secret-0123456789";
const business = {
  phoneNumberId: "100000000000001",
  wabaId: "200000000000002",
  displayPhoneNumber: "15550000000",
};

interface ReceivedWebhook {
  validSignature: boolean;
  payload: unknown;
}

let mediaDir: string;
let mediaStore: MediaStore;
let receiver: Server;
let receiverUrl: string;
const received: ReceivedWebhook[] = [];
let fake: FakeGraph | undefined;

beforeAll(async () => {
  mediaDir = mkdtempSync(join(tmpdir(), "smartops-sim-"));
  mediaStore = createMediaStore(mediaDir);
  // Stands in for the API webhook endpoint: records signed status webhooks.
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      received.push({
        validSignature: isValidWhatsAppSignature(
          raw,
          req.headers["x-hub-signature-256"] as string,
          SECRET,
        ),
        payload: JSON.parse(raw.toString("utf8")),
      });
      res.writeHead(200).end("OK");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
});

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
  rmSync(mediaDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  received.length = 0;
});

async function start(overrides: Partial<FakeGraphOptions> = {}): Promise<GraphApiConfig> {
  fake = createFakeGraph({
    business,
    accessToken: TOKEN,
    appSecret: SECRET,
    webhookUrl: receiverUrl,
    mediaStore,
    logger: pino({ level: "silent" }),
    statusDelayMs: 20,
    ...overrides,
  });
  const baseUrl = await fake.listen(0);
  return { baseUrl, version: "v26.0", accessToken: TOKEN, timeoutMs: 5_000 };
}

async function waitForWebhooks(count: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() > deadline)
      throw new Error(`expected ${count} webhooks, got ${received.length}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function statusesOf(webhooks: ReceivedWebhook[]) {
  return webhooks.map((w) => {
    const parsed = parseWhatsAppWebhook(w.payload);
    if (!parsed.recognized) throw new Error("status webhook not recognized");
    return parsed.changes[0]?.statuses[0];
  });
}

describe("fake Graph API — auth", () => {
  it("rejects a wrong token with Graph error 190 (production client → GraphApiError)", async () => {
    const config = await start();
    const error = await graphRequest(
      { ...config, accessToken: "wrong-token-000000000000000" },
      "GET",
      `${business.wabaId}/subscribed_apps`,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ httpStatus: 401, code: 190 });
  });

  it("answers subscribed_apps like Meta", async () => {
    const config = await start();
    await expect(
      graphRequest(config, "POST", `${business.wabaId}/subscribed_apps`),
    ).resolves.toEqual({ success: true });
  });
});

describe("fake Graph API — media", () => {
  it("returns metadata and a short-lived download URL that requires the token", async () => {
    const config = await start();
    const bytes = Buffer.from("%PDF-1.7\n% simulated price list\n");
    const stored = mediaStore.register(bytes, {
      mimeType: "application/pdf",
      filename: "lista.pdf",
    });

    const info = await graphRequest<{
      url: string;
      mime_type: string;
      sha256: string;
      file_size: number;
      id: string;
    }>(config, "GET", `${stored.id}?phone_number_id=${business.phoneNumberId}`);
    expect(info).toMatchObject({
      id: stored.id,
      mime_type: "application/pdf",
      sha256: stored.sha256Hex,
      file_size: bytes.length,
    });

    const anonymous = await fetch(info.url);
    expect(anonymous.status).toBe(401);

    const download = await fetch(info.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it("expires download URLs (404, like an expired lookaside URL)", async () => {
    let clock = 1_000_000;
    const config = await start({ now: () => clock, urlTtlMs: 5 * 60_000 });
    const stored = mediaStore.register(Buffer.from("x"), { mimeType: "text/plain" });
    const info = await graphRequest<{ url: string }>(config, "GET", stored.id);

    clock += 5 * 60_000 + 1;
    const res = await fetch(info.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("404s unknown media ids and media of another phone number", async () => {
    const config = await start();
    const stored = mediaStore.register(Buffer.from("x"), { mimeType: "text/plain" });
    for (const path of ["9999999999999999", `${stored.id}?phone_number_id=123456123`]) {
      await expect(graphRequest(config, "GET", path)).rejects.toMatchObject({
        httpStatus: 404,
        code: 100,
      });
    }
  });

  it("offers base64 sha256 when asked", async () => {
    const config = await start({ shaFormat: "base64" });
    const stored = mediaStore.register(Buffer.from("abc"), { mimeType: "text/plain" });
    const info = await graphRequest<{ sha256: string }>(config, "GET", stored.id);
    expect(Buffer.from(info.sha256, "base64").toString("hex")).toBe(stored.sha256Hex);
  });

  it("injects faults (e.g. media-info 500, download 404)", async () => {
    const config = await start({ faults: { "media-info": 500 } });
    const stored = mediaStore.register(Buffer.from("x"), { mimeType: "text/plain" });
    await expect(graphRequest(config, "GET", stored.id)).rejects.toMatchObject({ httpStatus: 500 });
  });
});

describe("fake Graph API — outbound messages", () => {
  it("accepts a text message and sends signed sent → delivered → read webhooks", async () => {
    const config = await start();
    const res = await graphRequest<{ messages: { id: string }[]; contacts: { wa_id: string }[] }>(
      config,
      "POST",
      `${business.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", to: "59899000111", type: "text", text: { body: "Hola" } },
    );
    const wamid = res.messages[0]?.id;
    expect(wamid).toMatch(/^wamid\./);
    expect(res.contacts[0]?.wa_id).toBe("59899000111");

    await waitForWebhooks(3);
    expect(received.every((w) => w.validSignature)).toBe(true);
    expect(statusesOf(received).map((s) => [s?.waMessageId, s?.status])).toEqual([
      [wamid, "sent"],
      [wamid, "delivered"],
      [wamid, "read"],
    ]);
  });

  it("templates are accepted with message_status and billed as utility", async () => {
    const config = await start({ statusFlow: ["sent"] });
    const res = await graphRequest<{ messages: { id: string; message_status?: string }[] }>(
      config,
      "POST",
      `${business.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: "59899000111",
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } },
      },
    );
    expect(res.messages[0]?.message_status).toBe("accepted");
    await waitForWebhooks(1);
    expect(statusesOf(received)[0]?.pricing).toMatchObject({ category: "utility" });
  });

  it("simulates a failed delivery with the configured Meta code", async () => {
    const config = await start({ failSendCode: 131030 });
    await graphRequest(config, "POST", `${business.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: "59899000111",
      type: "text",
      text: { body: "Hola" },
    });
    await waitForWebhooks(1);
    expect(statusesOf(received)[0]).toMatchObject({
      status: "failed",
      errors: [expect.objectContaining({ code: 131030 })],
    });
  });

  it("outside the 24h window only templates are delivered (text fails with 131047)", async () => {
    const config = await start({ outsideWindow: true, statusFlow: ["sent"] });
    const send = (body: Record<string, unknown>) =>
      graphRequest(config, "POST", `${business.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: "59899000111",
        ...body,
      });
    await send({ type: "text", text: { body: "Hola" } });
    await send({
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
    await waitForWebhooks(2);

    const statuses = statusesOf(received);
    expect(statuses.find((s) => s?.status === "failed")?.errors[0]?.code).toBe(131047);
    expect(statuses.some((s) => s?.status === "sent")).toBe(true);
  });

  it("validates the request body like Meta (400, code 100)", async () => {
    const config = await start();
    await expect(
      graphRequest(config, "POST", `${business.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: "59899000111",
        type: "text",
      }),
    ).rejects.toMatchObject({ httpStatus: 400, code: 100 });
    await expect(
      graphRequest(config, "POST", `999/messages`, {
        messaging_product: "whatsapp",
        to: "59899000111",
        type: "text",
        text: { body: "x" },
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });
});
