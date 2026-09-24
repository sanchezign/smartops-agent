import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/build-app.js";

describe("app (smoke)", () => {
  it("returns 404 with the JSON error shape for an unknown route", async () => {
    const res = await request(buildTestApp()).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route GET /does-not-exist not found",
        requestId: expect.any(String),
      },
    });
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("does not expose the x-powered-by header", async () => {
    const res = await request(buildTestApp()).get("/does-not-exist");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
