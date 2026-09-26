import request from "supertest";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/common/errors/app-error.js";
import { buildTestApp, stubAuthService } from "../helpers/build-app.js";

/** /api/v1/auth without a database (phase 8 M3): limits, headers and error shapes. */

const csrf = { "x-smartops-csrf": "1", origin: "http://localhost:3000" };
const rejectingAuth = {
  ...stubAuthService,
  login: async () => {
    throw errors.unauthorized("Invalid email or password");
  },
};

describe("panel auth routes", () => {
  it("limits login attempts per IP (429 in the standard error shape)", async () => {
    const app = buildTestApp({ auth: rejectingAuth, env: { LOGIN_RATE_LIMIT_MAX: "2" } });
    const attempt = () =>
      request(app).post("/api/v1/auth/login").set(csrf).send({ email: "a@x.uy", password: "x" });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("never caches auth responses", async () => {
    const res = await request(buildTestApp({ auth: rejectingAuth }))
      .post("/api/v1/auth/login")
      .set(csrf)
      .send({ email: "a@x.uy", password: "x" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unknown fields and oversized passwords before hashing anything", async () => {
    const app = buildTestApp({ auth: rejectingAuth });
    const extra = await request(app)
      .post("/api/v1/auth/login")
      .set(csrf)
      .send({ email: "a@x.uy", password: "x", role: "admin" });
    expect(extra.status).toBe(400);
    const huge = await request(app)
      .post("/api/v1/auth/login")
      .set(csrf)
      .send({ email: "a@x.uy", password: "x".repeat(1025) });
    expect(huge.status).toBe(400);
  });

  it("/me and /logout-all need a Bearer token", async () => {
    const app = buildTestApp();
    for (const call of [
      request(app).get("/api/v1/auth/me"),
      request(app).post("/api/v1/auth/logout-all"),
      request(app).get("/api/v1/auth/me").set("authorization", "Bearer not.a.jwt"),
    ]) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("logout without a cookie is a harmless 204", async () => {
    await request(buildTestApp()).post("/api/v1/auth/logout").set(csrf).expect(204);
  });
});
