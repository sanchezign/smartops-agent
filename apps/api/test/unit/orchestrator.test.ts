import { describe, expect, it, vi } from "vitest";
import {
  createInternalApiCaller,
  createOrchestrator,
  createOrchestratorClient,
  createSerialQueue,
  InternalCallError,
} from "../../src/modules/demo/demo-orchestrator.js";
import { N8nDeliveryError } from "../../src/modules/integration/n8n-delivery.js";

const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2bc";
const quiet = { info() {}, warn() {}, error() {} };
const flush = () => new Promise((r) => setTimeout(r, 0));
const payload = {
  version: 1,
  type: "message.ready",
  eventId: ID,
  messageId: ID,
  conversationId: ID,
  contactId: ID,
  contactKind: "supplier",
  messageType: "text",
  receivedAt: "2026-10-02T12:00:00.000Z",
};

describe("orchestrator retries like n8n (3 tries, 5 s apart)", () => {
  it("a call that fails twice and then works is not an error", async () => {
    const sleeps: number[] = [];
    let classify = 0;
    const calls: string[] = [];
    const o = createOrchestrator({
      call: async (m, p) => {
        calls.push(`${m} ${p}`);
        if (p === "/classify" && ++classify < 3) throw new Error("down");
        return { classification: "other" };
      },
      sleep: async (ms) => void sleeps.push(ms),
      logger: quiet,
    });
    await o.handle({ messageId: ID });
    expect(calls).toEqual(["POST /classify", "POST /classify", "POST /classify"]);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("waits 10 s between polls", async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const o = createOrchestrator({
      call: async (m, p) => {
        if (p === "/classify") return { classification: null, runId: ID };
        if (p === "/extract") return { status: "extracting" };
        if (m === "GET") return { status: ++polls >= 2 ? "extracted" : "extracting" };
        return {};
      },
      sleep: async (ms) => void sleeps.push(ms),
      logger: quiet,
    });
    await o.handle({ messageId: ID });
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  it("a classification without a runId is reported, not silently dropped", async () => {
    const reported: unknown[] = [];
    const o = createOrchestrator({
      call: async (_m, p, body) => {
        if (p === "/n8n/errors") reported.push(body);
        return { classification: "price_list_full" };
      },
      sleep: async () => {},
      logger: quiet,
    });
    await o.handle({ messageId: ID });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ workflow: "SmartOps · Receptor" });
  });
});

describe("serial queue (one sample at a time)", () => {
  it("never runs two tasks at once and keeps the order", async () => {
    const q = createSerialQueue({ max: 10 });
    let active = 0;
    let maxActive = 0;
    const done: number[] = [];
    const task = (n: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      done.push(n);
    };
    for (const n of [1, 2, 3, 4]) expect(q.push(task(n))).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(maxActive).toBe(1);
    expect(done).toEqual([1, 2, 3, 4]);
    expect(q.size).toBe(0);
  });

  it("refuses new work beyond its limit", () => {
    const q = createSerialQueue({ max: 1 });
    const never = () => new Promise<void>(() => {});
    expect(q.push(never)).toBe(true); // starts running
    expect(q.push(never)).toBe(true); // waits (1 pending)
    expect(q.push(never)).toBe(false); // full
  });
});

describe("orchestrator client (drop-in for the n8n client)", () => {
  it("accepts a valid event at once and processes it later", async () => {
    const handle = vi.fn(async () => {});
    const client = createOrchestratorClient({ orchestrator: { handle }, logger: quiet });
    await client.send(payload);
    await flush();
    expect(handle).toHaveBeenCalledWith({ messageId: ID });
  });

  it("rejects an invalid payload as a delivery error (400)", async () => {
    const client = createOrchestratorClient({ orchestrator: { handle: vi.fn() }, logger: quiet });
    await expect(client.send({ messageId: ID })).rejects.toMatchObject({
      name: "N8nDeliveryError",
      httpStatus: 400,
    });
  });

  it("answers 429 when the queue is full so the outbox retries later", async () => {
    const client = createOrchestratorClient({
      orchestrator: { handle: () => new Promise<void>(() => {}) },
      logger: quiet,
      maxQueue: 1,
    });
    await client.send(payload); // running
    await client.send(payload); // pending
    await expect(client.send(payload)).rejects.toBeInstanceOf(N8nDeliveryError);
  });

  it("an error inside the orchestrator is logged and never escapes", async () => {
    const error = vi.fn();
    const client = createOrchestratorClient({
      orchestrator: {
        handle: async () => {
          throw new Error("boom");
        },
      },
      logger: { error },
    });
    await client.send(payload);
    await flush();
    expect(error).toHaveBeenCalled();
  });
});

describe("internal API caller", () => {
  it("sends the key, the JSON body and parses the answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const call = createInternalApiCaller({
      baseUrl: "http://127.0.0.1:4000/",
      apiKey: "k".repeat(32),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await call("POST", "/classify", { messageId: ID })).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4000/api/v1/internal/classify");
    expect((init.headers as Record<string, string>)["x-internal-api-key"]).toBe("k".repeat(32));
    expect(init.body).toBe(JSON.stringify({ messageId: ID }));
  });

  it("turns an error answer into an InternalCallError with the API's message", async () => {
    const call = createInternalApiCaller({
      baseUrl: "http://x",
      apiKey: "k".repeat(32),
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 409,
        })) as unknown as typeof fetch,
    });
    await expect(call("POST", "/extract", {})).rejects.toMatchObject({
      name: "InternalCallError",
      status: 409,
      message: "POST /extract: 409 nope",
    });
    const refused = createInternalApiCaller({
      baseUrl: "http://x",
      apiKey: "k".repeat(32),
      fetch: (async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch,
    });
    await expect(refused("GET", "/runs/1")).rejects.toBeInstanceOf(InternalCallError);
  });
});
