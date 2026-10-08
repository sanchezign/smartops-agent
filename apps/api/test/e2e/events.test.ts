import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthService, AuthenticatedUser } from "../../src/modules/auth/auth.service.js";
import { createEventHub, type EventHub } from "../../src/modules/events/event-hub.js";
import { createLogger } from "../../src/common/logger.js";
import { parseEnv } from "../../src/config/env.js";
import { buildTestApp, stubAuthService, TEST_ENV_SOURCE } from "../helpers/build-app.js";

/**
 * GET /api/v1/events over a REAL HTTP server (SSE needs streaming): auth, the per-user cap,
 * events delivered, and the heartbeat that ends the stream when the session dies or the role
 * changes (phase 9 M4, ADR-020).
 */

const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const user: AuthenticatedUser = {
  userId: ID,
  role: "operator",
  email: "o@x.uy",
  name: "Op",
  sessionId: ID,
};

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function start(options: {
  session?: () => { userId: string; role: "admin" | "operator" } | null;
  heartbeatMs?: number;
  maxPerUser?: number;
  env?: Record<string, string>;
  user?: AuthenticatedUser;
}) {
  const env = parseEnv({ ...TEST_ENV_SOURCE, ...options.env });
  const hub: EventHub = createEventHub({
    maxPerUser: options.maxPerUser ?? 5,
    maxTotal: 50,
    flushMs: 5,
    logger: createLogger(env),
  });
  const auth: AuthService = {
    ...stubAuthService,
    authenticate: async (token) => (token === "good" ? (options.user ?? user) : null),
    checkSession: async () =>
      options.session ? options.session() : { userId: ID, role: "operator" },
  };
  const app = buildTestApp({
    auth,
    env: options.env ?? {},
    events: { hub, heartbeatMs: options.heartbeatMs ?? 60_000 },
  });
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/v1/events`;
  return { hub, base };
}

/** Reads SSE frames until `until` matches one of them (or times out). */
async function readUntil(res: Response, until: (frames: string[]) => boolean, ms = 3000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(frames)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;
    frames.push(...parts);
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

describe("GET /api/v1/events", () => {
  it("401 without a Bearer (EventSource-style ?token= is ignored)", async () => {
    const { base } = await start({});
    const res = await fetch(`${base}?token=good`);
    expect(res.status).toBe(401);
  });

  it("streams a ready event, then panel events (ids only)", async () => {
    const { hub, base } = await start({});
    const res = await fetch(base, { headers: { authorization: "Bearer good" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    setTimeout(() => hub.publish({ type: "run.changed", runId: ID, status: "ingested" }), 50);
    const frames = await readUntil(res, (f) => f.some((x) => x.includes("event: events")));
    expect(frames.some((f) => f.includes("event: ready"))).toBe(true);
    const events = frames.find((f) => f.includes("event: events"))!;
    expect(JSON.parse(events.split("data: ")[1]!)).toEqual([
      { type: "run.changed", runId: ID, status: "ingested" },
    ]);
  });

  it("POST streams too (the panel uses it: Cloudflare holds GET streams until they end)", async () => {
    const { hub, base } = await start({});
    const res = await fetch(base, { method: "POST", headers: { authorization: "Bearer good" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    setTimeout(() => hub.publish({ type: "run.changed", runId: ID, status: "ingested" }), 50);
    const frames = await readUntil(res, (f) => f.some((x) => x.includes("event: events")));
    expect(frames.some((f) => f.includes("event: ready"))).toBe(true);
    expect((await fetch(base, { method: "POST" })).status).toBe(401);
  });

  it("per-user cap → 429 TOO_MANY_STREAMS", async () => {
    const { base, hub } = await start({ maxPerUser: 1 });
    const first = await fetch(base, { headers: { authorization: "Bearer good" } });
    expect(first.status).toBe(200);
    const second = await fetch(base, { headers: { authorization: "Bearer good" } });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "TOO_MANY_STREAMS",
    );
    await first.body!.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.stats().total).toBe(0); // the closed stream freed its slot
  });

  // Phase 12 (user addendum A): in DEMO_MODE every visitor is the same public operator. A cap
  // per USER would leave the 6th visitor without real time, so for that account it is per IP.
  describe("the shared public demo operator", () => {
    const demoEnv = {
      DEMO_MODE: "true",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/smartops_demo",
      DEMO_OPERATOR_EMAIL: "demo@smartops.test",
      TRUST_PROXY: "1",
    };
    const open = (base: string, ip: string) =>
      fetch(base, { headers: { authorization: "Bearer good", "x-forwarded-for": ip } });

    it("its stream cap counts per client IP, not per user", async () => {
      const { base } = await start({
        maxPerUser: 1,
        env: demoEnv,
        user: { ...user, email: "Demo@Smartops.test" },
      });
      const a = await open(base, "203.0.113.10");
      expect(a.status).toBe(200);
      expect((await open(base, "203.0.113.10")).status).toBe(429); // same visitor, over the cap
      const b = await open(base, "203.0.113.11"); // another visitor still gets real time
      expect(b.status).toBe(200);
      await a.body!.cancel();
      await b.body!.cancel();
    });

    it("any other account keeps the per-user cap, whatever its IPs", async () => {
      const { base } = await start({ maxPerUser: 1, env: demoEnv });
      const a = await open(base, "203.0.113.10");
      expect(a.status).toBe(200);
      expect((await open(base, "203.0.113.11")).status).toBe(429);
      await a.body!.cancel();
    });
  });

  it.each([
    ["ended", () => null],
    ["role_changed", () => ({ userId: ID, role: "admin" as const })],
  ])("heartbeat: session %s → 'session' event and the stream ends", async (reason, session) => {
    const { base } = await start({ session, heartbeatMs: 50 });
    const res = await fetch(base, { headers: { authorization: "Bearer good" } });
    const frames = await readUntil(res, (f) => f.some((x) => x.includes("event: session")));
    const last = frames.find((f) => f.includes("event: session"))!;
    expect(JSON.parse(last.split("data: ")[1]!)).toEqual({ reason });
  });

  it("a live session gets comment pings and stays open", async () => {
    const { base } = await start({ heartbeatMs: 30 });
    const res = await fetch(base, { headers: { authorization: "Bearer good" } });
    const frames = await readUntil(res, (f) => f.filter((x) => x === ": ping").length >= 2);
    expect(frames.filter((x) => x === ": ping").length).toBeGreaterThanOrEqual(2);
  });
});
