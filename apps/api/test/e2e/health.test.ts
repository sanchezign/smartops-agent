import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp, downDb } from "../helpers/build-app.js";

describe("GET /api/v1/health", () => {
  it("returns 200 when the database is up", async () => {
    const res = await request(buildTestApp()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "up" });
    expect(res.body.uptimeSeconds).toEqual(expect.any(Number));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns 503 when the database is down", async () => {
    const res = await request(buildTestApp({ healthRepository: downDb })).get("/api/v1/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "error", db: "down" });
  });

  it("is not rate limited", async () => {
    const app = buildTestApp({ env: { RATE_LIMIT_MAX: "1" } });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/api/v1/health");
      expect(res.status).toBe(200);
    }
  });
});
