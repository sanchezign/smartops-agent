import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listRoutes } from "../../src/app.js";
import { adminRouteTable } from "../../src/modules/admin/admin.routes.js";
import type { AuthenticatedUser, AuthService } from "../../src/modules/auth/auth.service.js";
import { createDemoGraphRouter, createDemoMediaStore } from "../../src/modules/demo/demo-graph.js";
import { createDemoRouter } from "../../src/modules/demo/demo.routes.js";
import { buildTestApp, stubAdminDeps, stubAuthService } from "../helpers/build-app.js";

/**
 * Authorization matrix (phase 10 M2), generated from the routes the app REALLY serves
 * (`listRoutes`, fed by every `mount()` in app.ts, DEMO_MODE routers included): each route ×
 * (anonymous, operator, admin) → 401 / 403 / "allow" (anything else: the request got past
 * authentication and authorization). Compared with test/fixtures/authz-matrix.json:
 * - a NEW route without an entry fails (declare who may call it);
 * - a changed result fails (a permission changed: review it and edit the fixture).
 * Invariants below hold whatever the fixture says, so a careless regeneration cannot hide a
 * hole. Regenerate only on purpose: AUTHZ_RECORD=1 pnpm vitest run test/e2e/authz-matrix.test.ts
 */

type Outcome = 401 | 403 | "allow";
type Principal = "anonymous" | "operator" | "admin";
type Row = Record<Principal, Outcome>;

const FIXTURE = new URL("../fixtures/authz-matrix.json", import.meta.url);
const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const users: Record<string, AuthenticatedUser> = {
  "admin-token": { userId: ID, role: "admin", email: "a@x.uy", name: "Ana", sessionId: ID },
  "operator-token": { userId: ID, role: "operator", email: "o@x.uy", name: "Op", sessionId: ID },
};
const auth: AuthService = {
  ...stubAuthService,
  authenticate: async (token) => users[token] ?? null,
  checkSession: async () => ({ userId: ID, role: "operator" }),
};
const BEARER: Record<Principal, string | null> = {
  anonymous: null,
  operator: "operator-token",
  admin: "admin-token",
};
const PARAMS: Record<string, string> = {
  key: "bot.supplierAck",
  token: "t".repeat(43),
  wamid: "wamid.ABCDEFGHIJ",
  mediaId: "123",
  version: "v26.0",
  phoneNumberId: "1",
};
/** Query strings that make a probe meaningful: Meta's verification with a WRONG verify token. */
const QUERY: Record<string, string> = {
  "GET /api/v1/webhooks/whatsapp": "?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
};
const fill = (path: string) => path.replace(/:(\w+)/g, (_m, name: string) => PARAMS[name] ?? ID);

let server: Server;
let base: string;
let routes: string[];

beforeAll(async () => {
  const app = buildTestApp({
    auth,
    demo: {
      // The real demo Graph API router: its Bearer is the WhatsApp token, never a panel one.
      graphRouter: createDemoGraphRouter({
        store: createDemoMediaStore(),
        outbox: { sent: [] },
        accessToken: "whatsapp-access-token-of-the-demo",
        baseUrl: "http://127.0.0.1:1",
        business: { phoneNumberId: "1", wabaId: "2", displayPhoneNumber: "59800000000" },
        webhook: { url: "http://127.0.0.1:1/never", appSecret: "demo-app-secret" },
        logger: pino({ level: "silent" }),
      }),
      router: createDemoRouter({
        operator: { email: "demo@x.demo", password: "clave pública de la demo" },
        injector: { inject: vi.fn(async () => ({ wamid: "wamid.X" })) },
        trace: { byWamid: async () => ({ received: false as const }) },
        reset: { reset: vi.fn(), nextResetAt: () => null, start: vi.fn(), stop: vi.fn() },
        auth,
        rateLimit: { windowMs: 60_000, injectMax: 1_000, resetMax: 1_000 },
        logger: pino({ level: "silent" }),
      }),
    },
  });
  routes = listRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function outcome(route: string, who: Principal): Promise<Outcome> {
  const [method, path] = route.split(" ") as [string, string];
  const token = BEARER[who];
  const res = await fetch(`${base}${fill(path)}${QUERY[route] ?? ""}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(method === "GET" ? {} : { body: "{}" }),
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel(); // SSE streams never end: the status is enough
  return res.status === 401 || res.status === 403 ? res.status : "allow";
}

async function observe(): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  for (const route of routes) {
    out[route] = {
      anonymous: await outcome(route, "anonymous"),
      operator: await outcome(route, "operator"),
      admin: await outcome(route, "admin"),
    };
  }
  return out;
}

describe("authorization matrix", () => {
  it("every served route is in the matrix with the expected result for each principal", async () => {
    const observed = await observe();
    if (process.env.AUTHZ_RECORD === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Row>;
    expect(Object.keys(observed).sort(), "routes served vs routes in the matrix").toEqual(
      Object.keys(expected).sort(),
    );
    for (const route of routes) expect(observed[route], route).toEqual(expected[route]);
  });

  it("invariants that no fixture can override", async () => {
    const matrix = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Row>;
    // Anonymous callers only reach health, the public demo info and the login form endpoints.
    const publicRoutes = Object.entries(matrix)
      .filter(([, row]) => row.anonymous === "allow")
      .map(([route]) => route);
    expect(publicRoutes.sort()).toEqual(["GET /api/v1/demo/info", "GET /api/v1/health"]);
    for (const [route, row] of Object.entries(matrix)) {
      // Nobody without the right secret opens the internal API (n8n key), the webhook (Meta
      // signature / verify token) or the demo Graph API (WhatsApp token) — panel tokens included.
      if (
        route.includes("/api/v1/internal/") ||
        route.includes("/webhooks/") ||
        !route.includes(" /api/")
      )
        expect(Object.values(row), route).not.toContain("allow");
      // Every panel route needs a login.
      if (route.includes("/api/v1/admin/")) expect(row.anonymous, route).toBe(401);
    }
    // Admin-only routes of the declarative table answer 403 to an operator, the rest let it in.
    for (const r of adminRouteTable(stubAdminDeps)) {
      const row = matrix[`${r.method.toUpperCase()} /api/v1/admin${r.path}`]!;
      expect(row.admin).toBe("allow");
      expect(row.operator).toBe(r.roles.includes("operator") ? "allow" : 403);
    }
  });
});
