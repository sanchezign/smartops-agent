import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createErrorHandler } from "../../src/common/errors/error-handler.js";
import { getValidated, validate } from "../../src/common/middleware/validate.js";

const params = z.object({ id: z.uuid() });
const query = z.object({ limit: z.coerce.number().int().max(100).default(20) });
const body = z.object({ name: z.string().trim().min(1) });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/items/:id", validate({ params, query, body }), (_req, res) => {
    res.json({
      params: getValidated<typeof params>(res, "params"),
      query: getValidated<typeof query>(res, "query"),
      body: getValidated<typeof body>(res, "body"),
    });
  });
  app.use(createErrorHandler({ isProduction: true }));
  return app;
}

const ID = "0199a1b2-0000-7000-8000-000000000001";

describe("validate middleware", () => {
  it("passes parsed values (coerced, defaulted, trimmed) to the handler", async () => {
    const res = await request(buildApp()).post(`/items/${ID}`).send({ name: "  bolt " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: ID }, query: { limit: 20 }, body: { name: "bolt" } });
  });

  it("collects errors from every part into a 400 VALIDATION_ERROR", async () => {
    const res = await request(buildApp()).post("/items/not-a-uuid?limit=500").send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { location: string }) => d.location)).toEqual([
      "params",
      "query",
      "body",
    ]);
  });
});
