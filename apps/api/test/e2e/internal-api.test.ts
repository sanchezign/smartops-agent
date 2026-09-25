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
      ingestion: {
        ...stubInternalDeps.ingestion,
        getRun: async (runId) => {
          if (runId !== RUN_ID) throw errors.notFound("Ingestion run not found");
          return { runId, status: "extracting" } as never;
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

  it("GET /runs/:id reports the run status (n8n polls it)", async () => {
    const auth = { "X-Internal-Api-Key": TEST_INTERNAL_API_KEY };
    const ok = await request(app()).get(`/api/v1/internal/runs/${RUN_ID}`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ runId: RUN_ID, status: "extracting" });
    expect(ok.headers["cache-control"]).toBe("no-store");
    const bad = await request(app()).get("/api/v1/internal/runs/not-a-uuid").set(auth);
    expect(bad.status).toBe(400);
    const missing = await request(app())
      .get("/api/v1/internal/runs/0199a1b2-0000-7000-8000-000000000009")
      .set(auth);
    expect(missing.status).toBe(404);
    const noKey = await request(app()).get(`/api/v1/internal/runs/${RUN_ID}`);
    expect(noKey.status).toBe(401);
  });
});

describe("internal API: notifier endpoints (phase 6)", () => {
  const auth = { "X-Internal-Api-Key": TEST_INTERNAL_API_KEY };
  const calls: unknown[] = [];
  const phase6 = () =>
    buildTestApp({
      internal: {
        ...stubInternalDeps,
        notifications: {
          notify: async (input) => {
            calls.push(input);
            return { notified: false, reason: "nothing_actionable", items: 0 };
          },
          recordN8nError: async (input) => {
            calls.push(input);
            return { notified: true, items: 1, alertId: RUN_ID };
          },
        },
        supplierAck: { ack: async () => ({ sent: false, reason: "disabled" }) },
      },
    });

  it("validates bodies strictly and delegates", async () => {
    const bad = await request(phase6())
      .post("/api/v1/internal/notifications")
      .set(auth)
      .send({ kind: "run" });
    expect(bad.status).toBe(400);
    const unknownKind = await request(phase6())
      .post("/api/v1/internal/notifications")
      .set(auth)
      .send({ kind: "spam", runId: RUN_ID });
    expect(unknownKind.status).toBe(400);
    const ok = await request(phase6())
      .post("/api/v1/internal/notifications")
      .set(auth)
      .send({ kind: "run", runId: RUN_ID });
    expect(ok.body).toEqual({ notified: false, reason: "nothing_actionable", items: 0 });
    const error = await request(phase6())
      .post("/api/v1/internal/n8n/errors")
      .set(auth)
      .send({ workflow: "procesador", executionId: "12", message: "timeout" });
    expect(error.status).toBe(200);
    const ack = await request(phase6())
      .post("/api/v1/internal/messages/ack")
      .set(auth)
      .send({ runId: RUN_ID });
    expect(ack.body).toEqual({ sent: false, reason: "disabled" });
    const noKey = await request(phase6())
      .post("/api/v1/internal/n8n/errors")
      .send({ workflow: "x", message: "y" });
    expect(noKey.status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});
