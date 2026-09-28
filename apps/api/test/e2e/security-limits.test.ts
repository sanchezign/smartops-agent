import { pino } from "pino";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDemoRouter } from "../../src/modules/demo/demo.routes.js";
import type { AuthService } from "../../src/modules/auth/auth.service.js";
import { buildTestApp, stubAuthService, TEST_INTERNAL_API_KEY } from "../helpers/build-app.js";

/**
 * Every rate limiter of the API (phase 10 M6): each one answers 429 in the standard error
 * shape once its own budget is spent, and budgets are INDEPENDENT — Meta's webhook deliveries
 * or n8n's internal calls never eat the panel's budget, and a flood on the panel never blocks
 * the webhook (a lost webhook ack means Meta retries and eventually disables it).
 * The login limiter and the SSE stream caps are covered in auth-routes / events tests.
 */

const ID = "01a0dc63-e4b1-716c-a982-fbceaa90e2ba";
const limited = (res: request.Response) => {
  expect(res.status).toBe(429);
  expect(res.body.error).toMatchObject({ code: "RATE_LIMITED" });
  expect(typeof res.body.error.requestId).toBe("string");
};

describe("rate limiters", () => {
  it("webhook: its own budget; exhausting it leaves the panel budget untouched", async () => {
    const app = buildTestApp({ env: { WEBHOOK_RATE_LIMIT_MAX: "2", RATE_LIMIT_MAX: "2" } });
    for (let i = 0; i < 2; i += 1)
      expect(
        (
          await request(app)
            .post("/api/v1/webhooks/whatsapp")
            .set("content-type", "application/json")
            .send("{}")
        ).status,
      ).toBe(401);
    limited(
      await request(app)
        .post("/api/v1/webhooks/whatsapp")
        .set("content-type", "application/json")
        .send("{}"),
    );
    // The global (panel) budget of 2 was not consumed by the 3 webhook calls.
    expect((await request(app).get("/api/v1/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/v1/auth/me")).status).toBe(401);
    limited(await request(app).get("/api/v1/auth/me"));
  });

  it("a flood on the panel never blocks the webhook nor the internal API", async () => {
    const app = buildTestApp({ env: { RATE_LIMIT_MAX: "1" } });
    await request(app).get("/api/v1/auth/me");
    limited(await request(app).get("/api/v1/auth/me"));
    expect(
      (
        await request(app)
          .post("/api/v1/webhooks/whatsapp")
          .set("content-type", "application/json")
          .send("{}")
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/v1/internal/classify")
          .set("x-internal-api-key", TEST_INTERNAL_API_KEY)
          .send({})
      ).status,
    ).toBe(400); // past the limiter and the key: rejected by validation
    expect((await request(app).get("/api/v1/health")).status).toBe(200); // never limited
  });

  it("internal API: limited BEFORE the key check (a key guesser is throttled too)", async () => {
    const app = buildTestApp({ env: { INTERNAL_RATE_LIMIT_MAX: "2" } });
    for (let i = 0; i < 2; i += 1)
      expect(
        (await request(app).get("/api/v1/internal/rules").set("x-internal-api-key", "guess"))
          .status,
      ).toBe(401);
    limited(
      await request(app)
        .get("/api/v1/internal/rules")
        .set("x-internal-api-key", TEST_INTERNAL_API_KEY),
    );
  });

  const demoApp = (
    rateLimit: { injectMax: number; resetMax: number; injectGlobalPerHour: number },
    env: Record<string, string> = {},
  ) => {
    const auth: AuthService = {
      ...stubAuthService,
      authenticate: async () => ({
        userId: ID,
        role: "operator",
        email: "d@x.demo",
        name: "D",
        sessionId: ID,
      }),
    };
    return buildTestApp({
      auth,
      env,
      demo: {
        graphRouter: express.Router(),
        router: createDemoRouter({
          operator: { email: "d@x.demo", password: "clave pública de la demo" },
          injector: { inject: vi.fn(async () => ({ wamid: "wamid.X" })) },
          trace: { byWamid: async () => ({ received: false as const }) },
          reset: {
            reset: vi.fn(async () => ({
              suppliers: 0,
              products: 0,
              priceChanges: 0,
              reviewItems: 0,
              messages: 0,
            })),
            nextResetAt: () => null,
            start: vi.fn(),
            stop: vi.fn(),
          },
          auth,
          rateLimit: { windowMs: 60_000, ...rateLimit },
          logger: pino({ level: "silent" }),
        }),
      },
    });
  };
  const injectFrom = (app: ReturnType<typeof buildTestApp>, ip?: string) => {
    const req = request(app).post("/api/v1/demo/inject").set("authorization", "Bearer t");
    return (ip ? req.set("x-forwarded-for", ip) : req).send({ kind: "foto" });
  };

  it("demo: inject and reset have their own small budgets", async () => {
    const app = demoApp({ injectMax: 2, resetMax: 1, injectGlobalPerHour: 1_000 });
    expect((await injectFrom(app)).status).toBeLessThan(400);
    expect((await injectFrom(app)).status).toBeLessThan(400);
    limited(await injectFrom(app));
    const reset = () => request(app).post("/api/v1/demo/reset").set("authorization", "Bearer t");
    expect((await reset()).status).toBeLessThan(400);
    limited(await reset());
  });

  // Phase 12 (public demo): every visitor is the same public operator. Behind Caddy
  // (TRUST_PROXY=1) the per-IP budget follows the real client, and a global hourly cap bounds
  // what all visitors together can trigger.
  it("demo inject: per real client IP behind the proxy, plus one global cap for everybody", async () => {
    const app = demoApp(
      { injectMax: 1, resetMax: 1, injectGlobalPerHour: 3 },
      { TRUST_PROXY: "1" },
    );
    expect((await injectFrom(app, "203.0.113.1")).status).toBe(202);
    limited(await injectFrom(app, "203.0.113.1")); // per-IP budget of 1 spent
    expect((await injectFrom(app, "203.0.113.2")).status).toBe(202); // another visitor
    expect((await injectFrom(app, "203.0.113.3")).status).toBe(202);
    limited(await injectFrom(app, "203.0.113.4")); // fresh IP, but the global cap (3) is spent
  });
});
