import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminDeps } from "../../src/modules/admin/admin.routes.js";
import type { AuthenticatedUser, AuthService } from "../../src/modules/auth/auth.service.js";
import { ReviewKind, ReviewScope } from "../../src/generated/prisma/enums.js";
import { buildTestApp, stubAdminDeps, stubAuthService } from "../helpers/build-app.js";

/**
 * Authorization matrix, ITEM-LEVEL section (ADR-030, phase 14 M4b). The route matrix
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
  });

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
      // DEMO_MODE ON: the same, plus exactly the column-mapping review of a whole list
      const demoExtra = scope === "run" && kind === "column_mapping";
      expect(matrix.on.operator[key], `on operator ${key}`).toBe(
        scope === "line" || demoExtra ? "allow" : 403,
      );
    }
    // the one difference between the two modes
    const differing = Object.keys(matrix.off.operator).filter(
      (k) => matrix.off.operator[k] !== matrix.on.operator[k],
    );
    expect(differing).toEqual(["run/column_mapping"]);
  });
});
