import request from "supertest";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/common/errors/app-error.js";
import { buildTestApp, stubInternalDeps, TEST_INTERNAL_API_KEY } from "../helpers/build-app.js";

/** Internal API for n8n without Postgres: auth, validation, error shape, delegation. */

const RUN_ID = "0199a1b2-0000-7000-8000-000000000001";

function app() {
  return buildTestApp({
    internal: {
      ...stubInternalDeps,
      catalog: {
        ingest: async (runId) => {
          if (runId !== RUN_ID) throw errors.notFound("Ingestion run not found");
          return { runId, status: "ingested", supplierId: null, pendingReviews: 0, warnings: [] };
        },
      },
      settings: {
        getAll: async () => ({ "catalog.maxIncreasePct": 50 }) as never,
        getCatalogSettings: stubInternalDeps.settings.getCatalogSettings,
      },
    },
  });
}

describe("internal API (/api/v1/internal)", () => {
  it("rejects requests without the key or with a wrong one (401, standard error shape)", async () => {
    const missing = await request(app())
      .post("/api/v1/internal/catalog/ingest")
      .send({ runId: RUN_ID });
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(missing.body.error.requestId).toBeTruthy();
    const wrong = await request(app())
      .get("/api/v1/internal/rules")
      .set("X-Internal-Api-Key", `${TEST_INTERNAL_API_KEY}x`);
    expect(wrong.status).toBe(401);
  });

  it("validates bodies and delegates to the services", async () => {
    const auth = { "X-Internal-Api-Key": TEST_INTERNAL_API_KEY };
    const invalid = await request(app())
      .post("/api/v1/internal/catalog/ingest")
      .set(auth)
      .send({ runId: RUN_ID, extra: true });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const ok = await request(app())
      .post("/api/v1/internal/catalog/ingest")
      .set(auth)
      .send({ runId: RUN_ID });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ runId: RUN_ID, status: "ingested" });

    const notFound = await request(app())
      .post("/api/v1/internal/catalog/ingest")
      .set(auth)
      .send({ runId: "0199a1b2-0000-7000-8000-000000000002" });
    expect(notFound.status).toBe(404);

    const rules = await request(app()).get("/api/v1/internal/rules").set(auth);
    expect(rules.status).toBe(200);
    expect(rules.headers["cache-control"]).toBe("no-store");
    expect(rules.body).toEqual({ rules: { "catalog.maxIncreasePct": 50 } });
  });
});
