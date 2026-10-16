import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminDeps } from "../../src/modules/admin/admin.routes.js";
import type { AuthenticatedUser, AuthService } from "../../src/modules/auth/auth.service.js";
import { ReviewKind, ReviewScope } from "../../src/generated/prisma/enums.js";
import { buildTestApp, stubAdminDeps, stubAuthService } from "../helpers/build-app.js";

/**
 * Authorization matrix, ITEM-LEVEL section (ADR-030, phase 14 M4b; ADR-034, phase 16 M2). The route matrix
 * (authz-matrix.test.ts) answers "who may call this route"; whether someone may resolve a given
 * review item is decided inside the handler, per item, so it needs its own matrix.
 *
 * For DEMO_MODE off and on, each principal (anonymous / operator / admin) approves and rejects an
 * item of EVERY scope × kind through the real HTTP stack; the outcome (401 / 403 / "allow") is
 * compared with test/fixtures/authz-review-matrix.json. The invariants below restate the rule
 * independently of `canResolveReview`, so a careless regeneration of the fixture cannot hide a
 * hole. Regenerate only on purpose: AUTHZ_RECORD=1 pnpm vitest run test/e2e/authz-review-matrix.test.ts
 */
type Outcome = 401 | 403 | "allow";
type Principal = "anonymous" | "operator" | "admin";
type Mode = "off" | "on";
type Matrix = Record<Mode, Record<Principal, Record<string, Outcome>>>;

const FIXTURE = new URL("../fixtures/authz-review-matrix.json", import.meta.url);
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
const SCOPES = Object.values(ReviewScope);
const KINDS = Object.values(ReviewKind);

/** The item the stubbed service "finds": the handler decides on ITS scope and kind. */
let current: { scope: ReviewScope; kind: ReviewKind } = { scope: "line", kind: "product_match" };
const servers: Record<Mode, { server: Server; base: string }> = {} as never;

function adminDeps(demoMode: boolean): AdminDeps {
  const resolved = vi.fn(async () => ({
    reviewItemId: ID,
    kind: current.kind,
    status: "approved" as const,
    runId: ID,
    resolution: {},
  }));
  return {
    ...stubAdminDeps,
    demoMode,
    reviews: {
      ...stubAdminDeps.reviews,
      get: async () => ({ id: ID, ...current }) as never,
      approve: resolved,
      reject: resolved,
    },
    retriggerRun: async () => ({ retriggered: false }),
  };
}

beforeAll(async () => {
  for (const mode of ["off", "on"] as const) {
    const app = buildTestApp({ auth, admin: adminDeps(mode === "on") });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    servers[mode] = { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
});
afterAll(async () => {
  for (const { server } of Object.values(servers)) await new Promise((r) => server.close(r));
});

async function resolve(
  mode: Mode,
  who: Principal,
  item: typeof current,
  action: "approve" | "reject",
): Promise<Outcome> {
  current = item;
  const token = BEARER[who];
  const res = await fetch(`${servers[mode].base}/api/v1/admin/reviews/${ID}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel();
  return res.status === 401 || res.status === 403 ? res.status : "allow";
}

async function observe(): Promise<Matrix> {
  const out = {} as Matrix;
  for (const mode of ["off", "on"] as const) {
    out[mode] = { anonymous: {}, operator: {}, admin: {} };
    for (const who of ["anonymous", "operator", "admin"] as const)
      for (const scope of SCOPES)
        for (const kind of KINDS) {
          const approve = await resolve(mode, who, { scope, kind }, "approve");
          const reject = await resolve(mode, who, { scope, kind }, "reject");
          // approving and rejecting are the same permission
          expect(reject, `${mode} ${who} ${scope}/${kind}`).toBe(approve);
          out[mode][who][`${scope}/${kind}`] = approve;
        }
  }
  return out;
}

describe("authorization matrix: review items (role × scope × kind × DEMO_MODE)", () => {
  it("matches the recorded matrix for every item", async () => {
    const observed = await observe();
    if (process.env.AUTHZ_RECORD === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Matrix;
    expect(observed).toEqual(expected);
  }, 30_000); // ~540 requests through the real stack: the default 5 s is too tight under load

  it("invariants that no fixture can override", () => {
    const matrix = JSON.parse(readFileSync(FIXTURE, "utf8")) as Matrix;
    const items = SCOPES.flatMap((scope) => KINDS.map((kind) => ({ scope, kind })));
    expect(Object.keys(matrix.off.operator)).toHaveLength(items.length);
    for (const mode of ["off", "on"] as const) {
      for (const { scope, kind } of items) {
        const key = `${scope}/${kind}`;
        // nobody resolves anything without a session; an admin resolves everything; an operator
        // always resolves product lines
        expect(matrix[mode].anonymous[key], `${mode} anonymous ${key}`).toBe(401);
        expect(matrix[mode].admin[key], `${mode} admin ${key}`).toBe("allow");
        if (scope === "line")
          expect(matrix[mode].operator[key], `${mode} operator ${key}`).toBe("allow");
      }
    }
    for (const { scope, kind } of items) {
      const key = `${scope}/${kind}`;
      // DEMO_MODE OFF: the phase 8 rule — an operator resolves line items only
      expect(matrix.off.operator[key], `off operator ${key}`).toBe(
        scope === "line" ? "allow" : 403,
      );
      // DEMO_MODE ON (ADR-034): the public operator resolves every review
      expect(matrix.on.operator[key], `on operator ${key}`).toBe("allow");
    }
    // the only differences between the two modes: the operator's non-line items
    const differing = Object.keys(matrix.off.operator).filter(
      (k) => matrix.off.operator[k] !== matrix.on.operator[k],
    );
    expect(differing).toEqual(
      items.filter((i) => i.scope !== "line").map((i) => `${i.scope}/${i.kind}`),
    );
  });
});

/**
 * Phase 16 M2 (ADR-034): `demoMode` comes ONLY from env.DEMO_MODE on the server. A request that
 * claims the demo — in the query, a header, a cookie or the body — on an installation WITHOUT the
 * demo is still refused, and the To do counters are still computed as the real system.
 */
describe("DEMO_MODE cannot be claimed by a request (phase 16 M2)", () => {
  const gate = { scope: "run", kind: "suspicious_instructions" } as const;
  // Its own server (DEMO_MODE off): the matrix above already spent the rate limit of its servers.
  const todo = vi.fn(async () => ({
    counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
    groups: [],
    groupsTruncated: false,
    alerts: [],
  }));
  const summary = vi.fn(async () => ({
    total: 0,
    reviews: { canResolve: 0, waitingForAdmin: 0 },
    alerts: 0,
  }));
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const app = buildTestApp({
      auth,
      admin: { ...adminDeps(false), todoQuery: { todo, summary } as never },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  const claims: { name: string; path?: string; headers?: Record<string, string>; body?: string }[] =
    [
      { name: "query", path: "?demoMode=true&demo_mode=true&DEMO_MODE=true&demo=1" },
      {
        name: "headers",
        headers: { "x-demo-mode": "true", "demo-mode": "true", "x-demo": "1", demomode: "true" },
      },
      { name: "cookie", headers: { cookie: "demoMode=true; DEMO_MODE=true; demo=1" } },
      { name: "body", body: JSON.stringify({ demoMode: true, DEMO_MODE: true }) },
    ];

  for (const claim of claims)
    for (const action of ["approve", "reject"] as const)
      it(`an operator claiming the demo in the ${claim.name} still gets 403 (${action})`, async () => {
        current = gate;
        const res = await fetch(`${base}/api/v1/admin/reviews/${ID}/${action}${claim.path ?? ""}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer operator-token",
            ...claim.headers,
          },
          body: "{}",
          signal: AbortSignal.timeout(5_000),
        });
        await res.body?.cancel();
        expect(res.status).toBe(403);
      });

  it("the To do counters of a real installation ignore a demo claim (demoMode false reaches the query)", async () => {
    for (const path of ["/admin/todo", "/admin/todo/summary"]) {
      const res = await fetch(`${base}/api/v1${path}?demoMode=true`, {
        headers: {
          authorization: "Bearer operator-token",
          "x-demo-mode": "true",
          cookie: "demoMode=true",
        },
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel();
      expect(res.status, path).toBe(200);
    }
    expect(todo).toHaveBeenCalledWith({ role: "operator", demoMode: false });
    expect(summary).toHaveBeenCalledWith({ role: "operator", demoMode: false });
  });
});
