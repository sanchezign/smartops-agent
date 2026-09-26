import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventHub,
  TooManyStreamsError,
  type HubMessage,
} from "../../src/modules/events/event-hub.js";
import { parsePanelEvent, type PanelEvent } from "../../src/modules/events/panel-events.js";
import { createPgListener, type ListenClient } from "../../src/modules/events/pg-listener.js";

/** Panel real time (phase 9 M4, ADR-020): event validation, fan-out hub, LISTEN connection. */

const C = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const M = "01a0dc63-e4b1-716c-a982-fbceaa90e2bb";
const log = pino({ level: "silent" });

describe("parsePanelEvent", () => {
  it("keeps known events and ONLY their declared fields (never content)", () => {
    const event = parsePanelEvent(
      JSON.stringify({
        type: "message.created",
        conversationId: C,
        messageId: M,
        direction: "inbound",
        text: "hola, mi número es 099…",
      }),
    );
    expect(event).toEqual({
      type: "message.created",
      conversationId: C,
      messageId: M,
      direction: "inbound",
    });
  });

  it.each([
    undefined,
    "not json",
    JSON.stringify({ type: "user.deleted", id: C }),
    JSON.stringify({ type: "review.changed", reviewId: "nope", status: "pending" }),
    JSON.stringify({ type: "catalog.changed", supplierIds: Array(51).fill(C) }),
  ])("drops %j", (payload) => {
    expect(parsePanelEvent(payload)).toBeNull();
  });
});

describe("event hub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const event = (status: string): PanelEvent => ({ type: "review.changed", reviewId: C, status });
  const sub = (userId: string) => {
    const received: HubMessage[] = [];
    return { userId, received, send: (m: HubMessage) => received.push(m), end: vi.fn() };
  };

  it("fans out to every stream, coalescing duplicates within the flush window", () => {
    const hub = createEventHub({ maxPerUser: 5, maxTotal: 10, flushMs: 250, logger: log });
    const a = sub("u1");
    const b = sub("u2");
    hub.subscribe(a);
    hub.subscribe(b);
    hub.publish(event("pending"));
    hub.publish(event("pending"));
    hub.publish(event("approved"));
    expect(a.received).toEqual([]);
    vi.advanceTimersByTime(250);
    for (const s of [a, b]) {
      expect(s.received).toEqual([
        { kind: "events", events: [event("pending"), event("approved")] },
      ]);
    }
  });

  it("caps streams per user and in total; unsubscribing frees the slot", () => {
    const hub = createEventHub({ maxPerUser: 2, maxTotal: 3, flushMs: 250, logger: log });
    const off = hub.subscribe(sub("u1"));
    hub.subscribe(sub("u1"));
    expect(() => hub.subscribe(sub("u1"))).toThrow(TooManyStreamsError);
    off();
    off(); // idempotent
    hub.subscribe(sub("u1"));
    hub.subscribe(sub("u2"));
    expect(() => hub.subscribe(sub("u3"))).toThrow(expect.objectContaining({ scope: "total" }));
    expect(hub.stats()).toEqual({ total: 3, users: 2 });
  });

  it("one broken stream does not stop the others; resync and close reach everyone", () => {
    const hub = createEventHub({ maxPerUser: 5, maxTotal: 10, flushMs: 10, logger: log });
    const good = sub("u1");
    hub.subscribe({
      userId: "u2",
      send: () => {
        throw new Error("socket closed");
      },
      end: vi.fn(),
    });
    hub.subscribe(good);
    hub.publish(event("pending"));
    vi.advanceTimersByTime(10);
    expect(good.received).toHaveLength(1);
    hub.resync();
    expect(good.received.at(-1)).toEqual({ kind: "resync" });
    hub.close();
    expect(good.end).toHaveBeenCalledOnce();
    expect(hub.stats().total).toBe(0);
  });
});

describe("pg listener", () => {
  function fakeClient() {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const client = {
      queries: [] as string[],
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        client.queries.push(sql);
      }),
      end: vi.fn(async () => undefined),
      on: (event: string, cb: (arg?: unknown) => void) => {
        (handlers[event] ??= []).push(cb);
        return client;
      },
      removeAllListeners: () => {
        for (const k of Object.keys(handlers)) delete handlers[k];
      },
      emit: (event: string, arg?: unknown) => handlers[event]?.forEach((cb) => cb(arg)),
    };
    return client;
  }

  it("LISTENs once, forwards valid events, drops unknown ones, reconnects and asks for a resync", async () => {
    vi.useFakeTimers();
    const clients: ReturnType<typeof fakeClient>[] = [];
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const listener = createPgListener({
      connectionString: "postgres://x",
      onEvent,
      onReconnect,
      logger: log,
      createClient: () => {
        const c = fakeClient();
        clients.push(c);
        return c as unknown as ListenClient;
      },
      backoffMs: () => 1000,
    });
    await listener.start();
    expect(clients[0]!.queries).toEqual(["LISTEN smartops_events"]);
    expect(listener.connected()).toBe(true);

    clients[0]!.emit("notification", {
      channel: "smartops_events",
      payload: JSON.stringify({ type: "run.changed", runId: C, status: "ingested" }),
    });
    clients[0]!.emit("notification", { channel: "smartops_events", payload: "{bad" });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      type: "run.changed",
      runId: C,
      status: "ingested",
    });

    clients[0]!.emit("error", new Error("connection terminated"));
    expect(listener.connected()).toBe(false);
    expect(onReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    expect(listener.connected()).toBe(true);
    expect(onReconnect).toHaveBeenCalledOnce();

    await listener.stop();
    clients[1]!.emit("end");
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2); // stopped: no reconnection
    vi.useRealTimers();
  });
});
