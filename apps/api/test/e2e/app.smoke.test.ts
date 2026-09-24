import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

describe("app (scaffold smoke test)", () => {
  it("returns 404 for an unknown route", async () => {
    const res = await request(createApp()).get("/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("does not expose the x-powered-by header", async () => {
    const res = await request(createApp()).get("/does-not-exist");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
