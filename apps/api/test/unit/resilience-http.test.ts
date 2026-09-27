import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../src/ai/providers/anthropic.js";
import { z } from "zod";
import { LlmError } from "../../src/ai/llm-provider.js";
import { createN8nClient, N8nDeliveryError } from "../../src/modules/integration/n8n-delivery.js";
import {
  createWhatsAppMediaClient,
  MediaDownloadError,
} from "../../src/modules/whatsapp/whatsapp-media.client.js";
import {
  createWhatsAppSendClient,
  WhatsAppSendError,
} from "../../src/modules/whatsapp/whatsapp-send.client.js";

/**
 * Resilience against slow and failing neighbours (phase 10 M5), over REAL HTTP to a local
 * server — not mocked fetch: a peer that never answers, answers after the deadline, cuts a
 * download mid-body, rate-limits (429 + retry-after) or fails (5xx). Every case must end in a
 * typed, RETRYABLE error within its timeout (pg-boss does the retrying), never a hang, and the
 * permanent ones must stay permanent. Retry-After is NOT honoured: the queues' own backoff
 * applies (documented in docs/testing.md).
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handler: Handler = (_req, res) => res.writeHead(500).end();
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy(); // hanging requests of the "never answers" cases
  await new Promise((r) => server.close(r));
});

const hang: Handler = () => undefined; // never answers
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) =>
    res
      .writeHead(status, { "content-type": "application/json", ...headers })
      .end(JSON.stringify(body));
const after =
  (ms: number, h: Handler): Handler =>
  (req, res) =>
    setTimeout(() => h(req, res), ms);

/** Resolves with the rejection and how long it took. */
async function timed(p: Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const t0 = Date.now();
  const err = await p.then(
    () => new Error("expected a rejection"),
    (e: unknown) => e,
  );
  return { err, ms: Date.now() - t0 };
}

describe("n8n delivery client", () => {
  const client = () =>
    createN8nClient({ url: `${base}/webhook/smartops`, secret: "s".repeat(32), timeoutMs: 200 });

  it("n8n that never answers → error within the timeout (null status: unreachable)", async () => {
    handler = hang;
    const { err, ms } = await timed(client().send({ ok: 1 }));
    expect(err).toBeInstanceOf(N8nDeliveryError);
    expect(err).toMatchObject({ httpStatus: null });
    expect((err as Error).message).toMatch(/n8n unreachable/);
    expect(ms).toBeLessThan(2_000);
  });

  it("slow but inside the timeout → delivered", async () => {
    handler = after(50, json(200, { message: "Workflow was started" }));
    await expect(client().send({ ok: 1 })).resolves.toBeUndefined();
  });

  it("5xx → error with the status, body truncated to 300 chars", async () => {
    handler = json(503, { detail: "x".repeat(1_000) });
    const { err } = await timed(client().send({ ok: 1 }));
    expect(err).toMatchObject({ httpStatus: 503 });
    expect((err as Error).message.length).toBeLessThan(400);
  });
});

describe("WhatsApp media client (Graph API)", () => {
  const client = () =>
    createWhatsAppMediaClient({
      graph: { baseUrl: base, version: "v26.0", accessToken: "t", timeoutMs: 200 },
      phoneNumberId: "1",
      downloadTimeoutMs: 300,
      production: false,
    });

  it("media metadata that never arrives → timeout (retryable)", async () => {
    handler = hang;
    const { err, ms } = await timed(client().getMediaInfo("123"));
    expect(err).toBeInstanceOf(MediaDownloadError);
    expect(err).toMatchObject({ kind: "timeout" });
    expect(ms).toBeLessThan(2_000);
  });

  it("a download that stalls mid-body → timeout, nothing half-stored", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": "100000" });
      res.write(Buffer.alloc(1_000)); // …and never the rest
    };
    const { err, ms } = await timed(
      client().download(`${base}/media-download/1`, { maxBytes: 10_000_000 }),
    );
    expect(err).toMatchObject({ kind: "timeout" });
    expect(ms).toBeLessThan(2_000);
  });

  it.each([
    [429, { error: { message: "rate", code: 4 } }, { "retry-after": "30" }],
    [500, { error: { message: "boom", code: 1 } }, {}],
    [503, {}, {}],
  ])("HTTP %s from Graph → retryable http error with its status", async (status, body, headers) => {
    handler = json(status, body, headers);
    const { err } = await timed(client().getMediaInfo("123"));
    expect(err).toMatchObject({ kind: "http", httpStatus: status });
  });

  it("an expired token stays 'unauthorized' (retried with a loud log), not a timeout", async () => {
    handler = json(401, { error: { message: "expired", code: 190 } });
    const { err } = await timed(client().getMediaInfo("123"));
    expect(err).toMatchObject({ kind: "unauthorized" });
  });
});

describe("WhatsApp send client (Graph API)", () => {
  const client = () =>
    createWhatsAppSendClient({
      graph: { baseUrl: base, version: "v26.0", accessToken: "t", timeoutMs: 200 },
      phoneNumberId: "1",
    });
  const send = () =>
    client().send({
      messaging_product: "whatsapp",
      to: "59800000000",
      type: "text",
      text: { body: "hola" },
    });

  it("Graph that never answers → transient + retryable within the timeout", async () => {
    handler = hang;
    const { err, ms } = await timed(send());
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err).toMatchObject({ category: "transient", retryable: true });
    expect(ms).toBeLessThan(2_000);
  });

  it("Meta's rate limit (130429, HTTP 429 + retry-after) → rate_limited, retryable", async () => {
    handler = json(429, { error: { message: "rate", code: 130429 } }, { "retry-after": "60" });
    const { err } = await timed(send());
    expect(err).toMatchObject({ category: "rate_limited", retryable: true, metaCode: 130429 });
  });

  it("a 5xx → retryable; a closed window (131047) → permanent", async () => {
    handler = json(502, {});
    expect((await timed(send())).err).toMatchObject({ retryable: true });
    handler = json(400, { error: { message: "window", code: 131047 } });
    expect((await timed(send())).err).toMatchObject({ retryable: false });
  });

  it("a 200 without a message id → transient (never recorded as sent)", async () => {
    handler = json(200, { messages: [] });
    expect((await timed(send())).err).toMatchObject({ category: "transient", retryable: true });
  });
});

describe("Anthropic provider", () => {
  it("a model API that never answers → LlmError timeout, retryable, after the SDK's own retry", async () => {
    let calls = 0;
    // The SDK passes an AbortSignal; this fetch only ends when it fires.
    const neverAnswers: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    };
    const provider = createAnthropicProvider({
      apiKey: "sk-test-not-a-real-key",
      timeoutMs: 150,
      maxRetries: 1,
      fetch: neverAnswers,
    });
    const { err, ms } = await timed(
      provider.generateStructured({
        task: "classify",
        model: "claude-sonnet-5",
        system: "Short system prompt.",
        cacheSystem: false,
        content: [{ type: "text", text: "hola" }],
        jsonSchema: { type: "object", properties: {}, additionalProperties: false },
        schema: z.object({}),
        effort: "low",
        maxTokens: 100,
      }),
    );
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: "timeout", retryable: true });
    expect(calls).toBe(2); // maxRetries 1: one retry, never an open-ended loop
    expect(ms).toBeLessThan(5_000);
  });
});
