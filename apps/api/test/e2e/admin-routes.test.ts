import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  adminRouteTable,
  createAdminRouter,
  type AdminDeps,
} from "../../src/modules/admin/admin.routes.js";
import type { AuthenticatedUser, AuthService } from "../../src/modules/auth/auth.service.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";
import { ReviewKind, ReviewScope } from "../../src/generated/prisma/enums.js";
import { buildTestApp, stubAdminDeps, stubAuthService } from "../helpers/build-app.js";

/**
 * /api/v1/admin (phase 8 M4, ADR-018): route inventory (nothing unprotected), role matrix,
 * item-level review permissions and the re-trigger after an approval.
 */

const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const users: Record<string, AuthenticatedUser> = {
  "admin-token": { userId: ID, role: "admin", email: "a@x.uy", name: "Ana", sessionId: ID },
  "operator-token": { userId: ID, role: "operator", email: "o@x.uy", name: "Op", sessionId: ID },
};
const auth: AuthService = {
  ...stubAuthService,
  authenticate: async (token) => users[token] ?? null,
};
const pathFor = (path: string) =>
  `/api/v1/admin${path.replace(":id", ID).replace(":key", "bot.supplierAck")}`;

describe("route inventory: every /admin route is protected", () => {
  const table = adminRouteTable(stubAdminDeps);

  it("the router has exactly the routes of the declarative table (none added around it)", () => {
    const router = createAdminRouter({
      deps: stubAdminDeps,
      authenticate: auth.authenticate,
      logger: pino({ level: "silent" }),
    });
    const mounted = (
      router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
    )
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route!.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`),
      )
      .sort();
    expect(mounted).toEqual(table.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort());
    expect(table.length).toBeGreaterThanOrEqual(20);
  });

  it.each(table.map((r) => [r.method.toUpperCase(), r.path, r] as const))(
    "%s %s → 401 without a token",
    async (_m, _p, route) => {
      const res = await request(buildTestApp({ auth }))[route.method](pathFor(route.path));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it.each(
    table
      .filter((r) => !r.roles.includes("operator"))
      .map((r) => [r.method.toUpperCase(), r.path, r] as const),
  )("%s %s → 403 for an operator (admin only)", async (_m, _p, route) => {
    const res = await request(buildTestApp({ auth }))
      [route.method](pathFor(route.path))
      .set("authorization", "Bearer operator-token")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("admin-only routes are exactly the user decisions: opt-in, settings writes, users", () => {
    expect(
      table
        .filter((r) => !r.roles.includes("operator"))
        .map((r) => `${r.method.toUpperCase()} ${r.path}`)
        .sort(),
    ).toEqual(
      [
        "GET /users",
        "PATCH /users/:id",
        "POST /contacts/:id/opt-in",
        "POST /users",
        "POST /users/:id/reset-password",
        "POST /users/:id/revoke-sessions",
        "POST /users/:id/unlock",
        "PUT /settings/:key",
      ].sort(),
    );
  });
});

describe("review permissions (user rules)", () => {
  it("operator: line reviews only; admin: everything", () => {
    for (const scope of Object.values(ReviewScope)) {
      for (const kind of Object.values(ReviewKind)) {
        expect(canResolveReview("admin", { scope, kind })).toBe(true);
        expect(canResolveReview("operator", { scope, kind })).toBe(scope === "line");
      }
    }
  });

  function appWith(item: { scope: ReviewScope; kind: ReviewKind }, runStatusAfter = "ingested") {
    const approve = vi.fn(async () => ({
      reviewItemId: ID,
      kind: item.kind,
      status: "approved" as const,
      runId: ID,
      resolution: {},
    }));
    const retriggerRun = vi.fn(async () => ({ retriggered: runStatusAfter === "classified" }));
    const admin: AdminDeps = {
      ...stubAdminDeps,
      reviews: {
        ...stubAdminDeps.reviews,
        get: async () => ({ id: ID, ...item }) as never,
        approve,
        reject: approve,
      },
      retriggerRun,
    };
    return { app: buildTestApp({ auth, admin }), approve, retriggerRun };
  }

  it.each([
    ["run", "column_mapping"],
    ["run", "suspicious_instructions"],
    ["catalog", "global_change"],
    ["catalog", "mark_unavailable"],
  ] as const)("operator cannot resolve %s/%s (403, service untouched)", async (scope, kind) => {
    const { app, approve } = appWith({ scope, kind });
    for (const action of ["approve", "reject"]) {
      const res = await request(app)
        .post(`/api/v1/admin/reviews/${ID}/${action}`)
        .set("authorization", "Bearer operator-token")
        .send({});
      expect(res.status).toBe(403);
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("operator resolves a line review; the actor is the user", async () => {
    const { app, approve } = appWith({ scope: "line", kind: "product_match" });
    await request(app)
      .post(`/api/v1/admin/reviews/${ID}/approve`)
      .set("authorization", "Bearer operator-token")
      .send({ productId: ID })
      .expect(200);
    expect(approve).toHaveBeenCalledWith(
      ID,
      { productId: ID },
      expect.objectContaining({ type: "user", userId: ID }),
      expect.anything(),
    );
  });

  it("admin approving a column_mapping re-triggers the run (closes the phase 6 gap)", async () => {
    const { app, retriggerRun } = appWith({ scope: "run", kind: "column_mapping" }, "classified");
    const res = await request(app)
      .post(`/api/v1/admin/reviews/${ID}/approve`)
      .set("authorization", "Bearer admin-token")
      .send({ tables: [{ table: "T1", priceColumn: 4 }] })
      .expect(200);
    expect(res.body.retriggered).toBe(true);
    expect(retriggerRun).toHaveBeenCalledWith(ID, `review:${ID}`);
  });
});

describe("admin routes: validation and no-store", () => {
  it("validates ids and bodies before calling any service", async () => {
    const app = buildTestApp({ auth });
    const bearer = { authorization: "Bearer admin-token" };
    expect((await request(app).get("/api/v1/admin/reviews/not-a-uuid").set(bearer)).status).toBe(
      400,
    );
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/conversations/${ID}/pause`)
          .set(bearer)
          .send({ minutes: 0 })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/api/v1/admin/contacts/${ID}/opt-out`).set(bearer).send({})).status,
    ).toBe(400); // reason required
    expect(
      (await request(app).patch(`/api/v1/admin/users/${ID}`).set(bearer).send({})).status,
    ).toBe(400);
  });

  it("never caches panel data", async () => {
    const admin = {
      ...stubAdminDeps,
      settings: { ...stubAdminDeps.settings, getAll: async () => ({}) as never },
    };
    const res = await request(buildTestApp({ auth, admin }))
      .get("/api/v1/admin/settings")
      .set("authorization", "Bearer operator-token")
      .expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
