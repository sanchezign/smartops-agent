import express, { type Router } from "express";
import { z } from "zod";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { validate, getValidated } from "../../common/middleware/validate.js";
import { createRateLimiter } from "../../common/middleware/security.js";
import { createRequireAuth, currentUser } from "../auth/auth-http.js";
import type { AuthService } from "../auth/auth.service.js";
import type { DemoInjector } from "./demo-injector.js";
import { DEMO_SAMPLE_KINDS } from "./demo-injector.js";
import type { DemoReset } from "./demo-reset.js";
import type { DemoTraceRepository } from "./demo-trace.repository.js";

/**
 * /api/v1/demo/* — mounted ONLY in DEMO_MODE (phase 9 M8, ADR-021). Outside the demo these
 * routes do not exist (404), so the panel hides the demo page and the login hint.
 *
 *   GET  /info             public: it is a demo + the PUBLIC demo operator credentials
 *   POST /inject {kind}    a sample message into the real pipeline (login, rate limited)
 *   GET  /trace/:wamid     where that message is in the pipeline (login)
 *   POST /reset            "Reiniciar demo" (login, rate limited)
 */
export function createDemoRouter(options: {
  operator: { email: string; password: string };
  injector: DemoInjector;
  trace: DemoTraceRepository;
  reset: DemoReset;
  auth: Pick<AuthService, "authenticate">;
  rateLimit: {
    windowMs: number;
    injectMax: number;
    resetMax: number;
    /** Samples per hour for ALL visitors together (phase 12, public demo). */
    injectGlobalPerHour: number;
  };
  logger: Logger;
}): Router {
  const router = express.Router();

  router.get("/info", (_req, res) => {
    res.set("cache-control", "no-store").json({
      demoMode: true,
      operator: options.operator,
      nextResetAt: options.reset.nextResetAt(),
      samples: DEMO_SAMPLE_KINDS,
    });
  });

  const requireAuth = createRequireAuth(options.auth.authenticate);
  const injectLimiter = createRateLimiter({
    windowMs: options.rateLimit.windowMs,
    limit: options.rateLimit.injectMax,
  });
  // Every visitor is the same public operator, from many IPs: cap the total work too.
  const injectGlobalLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    limit: options.rateLimit.injectGlobalPerHour,
    global: true,
  });
  const resetLimiter = createRateLimiter({
    windowMs: options.rateLimit.windowMs,
    limit: options.rateLimit.resetMax,
  });
  const injectBody = z.object({ kind: z.enum(DEMO_SAMPLE_KINDS) }).strict();
  const traceParams = z
    .object({ wamid: z.string().regex(/^wamid\.[A-Za-z0-9_-]{8,120}$/) })
    .strict();

  router.post(
    "/inject",
    requireAuth,
    injectLimiter,
    injectGlobalLimiter,
    validate({ body: injectBody }),
    async (_req, res) => {
      const user = currentUser(res);
      const { kind } = getValidated<typeof injectBody>(res, "body");
      const result = await options.injector.inject(kind);
      options.logger.info({ kind, userId: user.userId }, "demo sample requested");
      res.status(202).json(result);
    },
  );

  router.get("/trace/:wamid", requireAuth, validate({ params: traceParams }), async (_req, res) => {
    const { wamid } = getValidated<typeof traceParams>(res, "params");
    res.set("cache-control", "no-store").json(await options.trace.byWamid(wamid));
  });

  router.post("/reset", requireAuth, resetLimiter, async (_req, res) => {
    const user = currentUser(res);
    options.logger.info({ userId: user.userId }, "demo reset requested");
    const result = await options.reset.reset("manual");
    res.json({ result, nextResetAt: options.reset.nextResetAt() });
  });

  router.use((_req, _res, next) => next(errors.notFound("Unknown demo route")));
  return router;
}
