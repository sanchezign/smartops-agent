import express, { type Express, type Router } from "express";
import helmet from "helmet";
import { createErrorHandler, notFoundHandler } from "./common/errors/error-handler.js";
import { decimalJsonReplacer } from "./common/json.js";
import type { Logger } from "./common/logger.js";
import { createHttpLogger } from "./common/middleware/http-logger.js";
import { createCors, createRateLimiter } from "./common/middleware/security.js";
import type { Env } from "./config/env.js";
import type { WebhookQueue } from "./jobs/queues.js";
import type { HealthRepository } from "./modules/health/health.repository.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createAdminRouter, type AdminDeps } from "./modules/admin/admin.routes.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createEventHub, type EventHub } from "./modules/events/event-hub.js";
import { createEventsRouter } from "./modules/events/events.routes.js";
import { createPublicAccount } from "./modules/demo/public-account.js";
import type { AuthService } from "./modules/auth/auth.service.js";
import { createInternalRouter, type InternalDeps } from "./modules/internal/internal.routes.js";
import type { WhatsAppWebhookRepository } from "./modules/whatsapp/whatsapp-webhook.repository.js";
import { createWhatsAppWebhookRouter } from "./modules/whatsapp/whatsapp-webhook.routes.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  healthRepository: HealthRepository;
  whatsappWebhookRepository: WhatsAppWebhookRepository;
  webhookQueue: WebhookQueue;
  /** Services behind the internal API for n8n (/api/v1/internal/*). */
  internal: InternalDeps;
  /** Panel auth (/api/v1/auth/*, phase 8). */
  auth: AuthService;
  /** Panel API (/api/v1/admin/*, phase 8 M4): every route behind a role. */
  admin: AdminDeps;
  /**
   * Panel real time (/api/v1/events, phase 9 M4): the process's event hub (fed by the one
   * LISTEN connection in server.ts). Omitted in tests: a hub nobody publishes to.
   */
  events?: { hub: EventHub; heartbeatMs: number };
  /**
   * DEMO_MODE only (phase 9 M8, ADR-021): the fake Graph API (root paths /v{n}/…,
   * /media-download/…) and /api/v1/demo/*. Absent → those routes do not exist.
   */
  demo?: { graphRouter: Router; router: Router };
}

export interface RouteMount {
  prefix: string;
  router: Router;
}

/** Every "METHOD /path" the app serves (from the recorded mounts; phase 10 M2). */
export function listRoutes(app: Express): string[] {
  const out = new Set<string>();
  for (const { prefix, router } of app.locals.routeMounts as RouteMount[]) {
    for (const layer of (
      router as unknown as {
        stack: { route?: { path: string; methods: Record<string, boolean> } }[];
      }
    ).stack) {
      if (!layer.route) continue;
      const path = `${prefix}${layer.route.path === "/" ? "" : layer.route.path}` || "/";
      for (const [method, on] of Object.entries(layer.route.methods))
        if (on && method !== "_all") out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...out].sort();
}

/** Builds the Express app without listening (server.ts listens; Supertest uses it directly). */
export function createApp({
  env,
  logger,
  healthRepository,
  whatsappWebhookRepository,
  webhookQueue,
  internal,
  auth,
  admin,
  events,
  demo,
}: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // Number of trusted proxy hops (Render = 1) so req.ip / rate limiting see the client IP.
  app.set("trust proxy", env.TRUST_PROXY);
  // Prisma Decimal → string in every JSON response.
  app.set("json replacer", decimalJsonReplacer);

  app.use(createHttpLogger(logger));
  app.use(helmet());
  app.use(createCors(env.CORS_ORIGINS));
  app.use(
    "/api/v1",
    createRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      // Webhooks and the internal API have their own limiters (see their routers).
      skipPaths: ["/health", "/webhooks/whatsapp"],
      skipPrefixes: ["/internal/"],
    }),
  );

  // Every router is mounted through mount(): the list feeds the authorization matrix test
  // (phase 10 M2), so a new router cannot appear without an entry in the matrix.
  const routeMounts: RouteMount[] = [];
  const mount = (parent: Express | Router, base: string, prefix: string, router: Router) => {
    if (prefix) (parent as Router).use(prefix, router);
    else (parent as Router).use(router);
    routeMounts.push({ prefix: `${base}${prefix}`, router });
  };

  // Webhooks need the RAW body for signature checks: mounted BEFORE express.json.
  mount(
    app,
    "",
    "/api/v1/webhooks/whatsapp",
    createWhatsAppWebhookRouter({
      repository: whatsappWebhookRepository,
      queue: webhookQueue,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.WEBHOOK_RATE_LIMIT_MAX },
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  if (demo) mount(app, "", "", demo.graphRouter);

  const v1 = express.Router();
  const V1 = "/api/v1";
  mount(v1, V1, "", createHealthRouter({ repository: healthRepository, logger }));
  mount(
    v1,
    V1,
    "/internal",
    createInternalRouter({
      ...internal,
      apiKey: env.INTERNAL_API_KEY,
      logger,
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.INTERNAL_RATE_LIMIT_MAX },
    }),
  );
  mount(v1, V1, "/auth", createAuthRouter({ service: auth, env, logger }));
  mount(
    v1,
    V1,
    "/admin",
    createAdminRouter({ deps: admin, authenticate: auth.authenticate, logger }),
  );
  mount(
    v1,
    V1,
    "/events",
    createEventsRouter({
      hub:
        events?.hub ??
        createEventHub({
          maxPerUser: env.SSE_MAX_STREAMS_PER_USER,
          maxTotal: env.SSE_MAX_STREAMS,
          flushMs: 250,
          logger,
        }),
      auth,
      heartbeatMs: events?.heartbeatMs ?? env.SSE_HEARTBEAT_SECONDS * 1000,
      logger,
      publicAccount: createPublicAccount({
        demoMode: env.DEMO_MODE,
        operatorEmail: env.DEMO_OPERATOR_EMAIL,
      }),
    }),
  );
  if (demo) mount(v1, V1, "/demo", demo.router);
  app.use(V1, v1);
  app.locals.routeMounts = routeMounts;

  app.use(notFoundHandler);
  app.use(createErrorHandler({ isProduction: env.NODE_ENV === "production" }));

  return app;
}
