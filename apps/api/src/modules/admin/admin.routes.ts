import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { getValidated, validate } from "../../common/middleware/validate.js";
import {
  AlertType,
  ReviewKind,
  ReviewScope,
  ReviewStatus,
  type UserRole,
} from "../../generated/prisma/enums.js";
import { createRequireAuth, currentUser } from "../auth/auth-http.js";
import type { AuthenticatedUser, AuthService } from "../auth/auth.service.js";
import { ADMIN_ONLY, ALL_ROLES, canResolveReview, requireRole } from "../auth/permissions.js";
import type { ConversationModeService } from "../conversations/conversation-mode.service.js";
import type { DashboardService } from "../dashboard/dashboard.service.js";
import type { HumanReplyService } from "../conversations/human-reply.service.js";
import type { OptOutRepository } from "../optout/optout.repository.js";
import type { MediaStorage } from "../media/media-storage.js";
import type { CatalogQueryRepository } from "./catalog-query.repository.js";
import type { ConversationQueryRepository } from "./conversation-query.repository.js";
import type { DigestLinkRepository } from "./digest-link.repository.js";
import { isOpen, nextOpening } from "../settings/business-hours.js";
import type { BusinessHours } from "../settings/settings.schemas.js";
import { mediaResponseHeaders } from "./media-response.js";
import type { ReviewQueryRepository } from "./review-query.repository.js";
import type { ReviewService } from "../reviews/review.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import { roleSchema, type UsersService } from "../users/users.service.js";

/**
 * /api/v1/admin/* — the panel's API (phase 8 M4, ADR-018). Every route requires a Bearer
 * access token; the ROLE per route is declared in ADMIN_ROUTES below (a route-inventory test
 * walks this table and the real router, so no route can be added unprotected). Item-level
 * rules (which review an operator may resolve) are checked inside the handler.
 */

export interface AdminDeps {
  /** DEMO_MODE (ADR-030): the public operator may resolve the column-mapping review. */
  demoMode: boolean;
  dashboard: Pick<DashboardService, "get">;
  /** Read model with context (supplier, product, source message) for the queue. */
  reviewQuery: Pick<ReviewQueryRepository, "list" | "get" | "summary" | "suppliers">;
  reviews: Pick<ReviewService, "list" | "get" | "approve" | "reject">;
  /** Re-emits message.ready for a run a review sent back to extraction (closes phase 6 gap). */
  retriggerRun(runId: string, reason: string): Promise<{ retriggered: boolean }>;
  mode: Pick<ConversationModeService, "status" | "pause" | "resume">;
  /** Inbox, chat history, opted-out list, media metadata (phase 9 M3). */
  conversationQuery: Pick<
    ConversationQueryRepository,
    "list" | "get" | "messages" | "optedOut" | "media"
  >;
  mediaStorage: Pick<MediaStorage, "get">;
  /** WhatsApp digest deep links /d/<token> (phase 9 M7). */
  digestLinks: Pick<DigestLinkRepository, "byToken">;
  /** Catalog, price history, alerts; rename supplier + acknowledge alert (phase 9 M5). */
  catalogQuery: Pick<
    CatalogQueryRepository,
    "suppliers" | "products" | "product" | "renameSupplier" | "alerts" | "acknowledgeAlert"
  >;
  humanReply: Pick<HumanReplyService, "reply">;
  consent: Pick<OptOutRepository, "find" | "apply">;
  settings: Pick<SettingsService, "getAll" | "set">;
  users: Pick<
    UsersService,
    "list" | "create" | "update" | "resetPassword" | "unlock" | "assertModifiable"
  >;
  sessions: { revokeAllForUser(userId: string, reason: string): Promise<number> };
}

interface Ctx {
  user: AuthenticatedUser;
  log: Logger;
  requestId?: string;
}

type Handler = (req: Request, res: Response, ctx: Ctx) => Promise<void>;

interface AdminRoute {
  method: "get" | "post" | "put" | "patch";
  path: string;
  roles: readonly UserRole[];
  schemas?: Parameters<typeof validate>[0];
  handler: Handler;
}

const idParams = z.object({ id: z.uuid() }).strict();
const enumOf = <T extends Record<string, string>>(e: T) =>
  z.enum(Object.values(e) as [T[keyof T], ...T[keyof T][]]);
const reviewQuery = z
  .object({
    status: enumOf(ReviewStatus).optional(),
    kind: enumOf(ReviewKind).optional(),
    scope: enumOf(ReviewScope).optional(),
    supplierId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
const dashboardQuery = z
  .object({ days: z.coerce.number().int().min(7).max(90).default(14) })
  .strict();
const inboxQuery = z
  .object({
    filter: z.enum(["all", "human", "opted_out", "suppliers", "customers"]).default("all"),
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const messagesQuery = z
  .object({
    before: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();
const productsQuery = z
  .object({
    supplierId: z.uuid().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    availability: z.enum(["all", "available", "unavailable"]).default("all"),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const renameBody = z.object({ name: z.string().trim().min(2).max(200) }).strict();
const alertsQuery = z
  .object({
    status: z.enum(["open", "all"]).default("open"),
    type: enumOf(AlertType).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
const tokenParams = z.object({ token: z.string().max(100) }).strict();
const pauseBody = z.object({ minutes: z.number().int().min(1).max(10_080).nullable() }).strict();
const replyBody = z.object({ text: z.string().trim().min(1).max(4_096) }).strict();
const consentBody = z
  .object({
    reason: z.string().trim().min(3).max(500),
    source: z.enum(["manual", "off_whatsapp"]).default("manual"),
  })
  .strict();
const settingParams = z.object({ key: z.string().min(1).max(100) }).strict();
const settingBody = z.object({ value: z.unknown() }).strict();
const createUserBody = z
  .object({
    email: z.string().max(254),
    name: z.string().max(120),
    role: roleSchema,
    password: z.string().max(1024),
  })
  .strict();
const patchUserBody = z
  .object({ role: roleSchema.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => b.role !== undefined || b.active !== undefined, "role or active is required");
const passwordBody = z.object({ password: z.string().max(1024) }).strict();

const reviewActor = (ctx: Ctx) => ({
  type: "user" as const,
  userId: ctx.user.userId,
  requestId: ctx.requestId ?? null,
});
const auditActor = (ctx: Ctx) => ({
  userId: ctx.user.userId,
  ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
});

function buildRoutes(deps: AdminDeps): AdminRoute[] {
  async function reviewOr404(id: string) {
    const item = await deps.reviews.get(id);
    if (!item) throw errors.notFound("Review item not found");
    return item;
  }
  async function resolveReview(
    req: Request,
    res: Response,
    ctx: Ctx,
    action: "approve" | "reject",
  ) {
    const { id } = getValidated<typeof idParams>(res, "params");
    const item = await reviewOr404(id);
    if (!canResolveReview(ctx.user.role, item, { demoMode: deps.demoMode }))
      throw errors.forbidden("Only an admin can resolve this review");
    const result = await deps.reviews[action](id, req.body ?? {}, reviewActor(ctx), ctx.log);
    const retrigger =
      action === "approve"
        ? await deps.retriggerRun(result.runId, `review:${id}`)
        : { retriggered: false };
    res.json({ result, retriggered: retrigger.retriggered });
  }

  return [
    // ── Dashboard ───────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/dashboard",
      roles: ALL_ROLES,
      schemas: { query: dashboardQuery },
      handler: async (_req, res) => {
        const { days } = getValidated<typeof dashboardQuery>(res, "query");
        res.json(await deps.dashboard.get(days));
      },
    },
    // ── Reviews ─────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/reviews",
      roles: ALL_ROLES,
      schemas: { query: reviewQuery },
      handler: async (_req, res) => {
        res.json({
          items: await deps.reviewQuery.list(getValidated<typeof reviewQuery>(res, "query")),
        });
      },
    },
    {
      method: "get",
      path: "/reviews/summary",
      roles: ALL_ROLES,
      handler: async (_req, res) => {
        res.json(await deps.reviewQuery.summary());
      },
    },
    {
      method: "get",
      path: "/reviews/:id",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const item = await deps.reviewQuery.get(getValidated<typeof idParams>(res, "params").id);
        if (!item) throw errors.notFound("Review item not found");
        res.json({ item });
      },
    },
    {
      method: "get",
      path: "/suppliers",
      roles: ALL_ROLES,
      handler: async (_req, res) => {
        res.json({ suppliers: await deps.reviewQuery.suppliers() });
      },
    },
    {
      method: "post",
      path: "/reviews/:id/approve",
      roles: ALL_ROLES, // item-level: operator → line only (canResolveReview)
      schemas: { params: idParams },
      handler: (req, res, ctx) => resolveReview(req, res, ctx, "approve"),
    },
    {
      method: "post",
      path: "/reviews/:id/reject",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: (req, res, ctx) => resolveReview(req, res, ctx, "reject"),
    },
    // ── Catalog + price history (phase 9 M5) ────────────────────────────────
    {
      method: "get",
      path: "/catalog/suppliers",
      roles: ALL_ROLES,
      handler: async (_req, res) => {
        res.json({ suppliers: await deps.catalogQuery.suppliers() });
      },
    },
    {
      method: "get",
      path: "/catalog/products",
      roles: ALL_ROLES,
      schemas: { query: productsQuery },
      handler: async (_req, res) => {
        res.json(
          await deps.catalogQuery.products(getValidated<typeof productsQuery>(res, "query")),
        );
      },
    },
    {
      method: "get",
      path: "/catalog/products/:id",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const product = await deps.catalogQuery.product(
          getValidated<typeof idParams>(res, "params").id,
        );
        if (!product) throw errors.notFound("Product not found");
        res.json({ product });
      },
    },
    {
      // Renaming changes how later lists are matched to the supplier: admin only, audited.
      method: "patch",
      path: "/catalog/suppliers/:id",
      roles: ADMIN_ONLY,
      schemas: { params: idParams, body: renameBody },
      handler: async (_req, res, ctx) => {
        const supplier = await deps.catalogQuery.renameSupplier({
          supplierId: getValidated<typeof idParams>(res, "params").id,
          name: getValidated<typeof renameBody>(res, "body").name,
          actor: { userId: ctx.user.userId, requestId: ctx.requestId ?? null },
        });
        res.json({ supplier });
      },
    },
    // ── Digest deep link (phase 9 M7) ───────────────────────────────────────
    {
      // Login required like every panel route; unknown and malformed tokens answer the same
      // 404 (no oracle). The token is random (256 bits) — never the digest id.
      method: "get",
      path: "/digests/:token",
      roles: ALL_ROLES,
      schemas: { params: tokenParams },
      handler: async (_req, res) => {
        const digest = await deps.digestLinks.byToken(
          getValidated<typeof tokenParams>(res, "params").token,
        );
        if (!digest) throw errors.notFound("Digest not found");
        res.json({ digest });
      },
    },
    // ── Alerts ──────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/alerts",
      roles: ALL_ROLES,
      schemas: { query: alertsQuery },
      handler: async (_req, res) => {
        res.json(await deps.catalogQuery.alerts(getValidated<typeof alertsQuery>(res, "query")));
      },
    },
    {
      method: "post",
      path: "/alerts/:id/acknowledge",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res, ctx) => {
        res.json(
          await deps.catalogQuery.acknowledgeAlert({
            alertId: getValidated<typeof idParams>(res, "params").id,
            actor: { userId: ctx.user.userId, requestId: ctx.requestId ?? null },
          }),
        );
      },
    },
    // ── Conversations (bot / human, ADR-016) ────────────────────────────────
    {
      method: "get",
      path: "/conversations",
      roles: ALL_ROLES,
      schemas: { query: inboxQuery },
      handler: async (_req, res) => {
        res.json(await deps.conversationQuery.list(getValidated<typeof inboxQuery>(res, "query")));
      },
    },
    {
      method: "get",
      path: "/conversations/:id",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const conversation = await deps.conversationQuery.get(
          getValidated<typeof idParams>(res, "params").id,
        );
        if (!conversation) throw errors.notFound("Conversation not found");
        res.json({ conversation });
      },
    },
    {
      method: "get",
      path: "/conversations/:id/messages",
      roles: ALL_ROLES,
      schemas: { params: idParams, query: messagesQuery },
      handler: async (_req, res) => {
        const page = await deps.conversationQuery.messages(
          getValidated<typeof idParams>(res, "params").id,
          getValidated<typeof messagesQuery>(res, "query"),
        );
        if (!page) throw errors.notFound("Conversation not found");
        res.json(page);
      },
    },
    {
      // Chat media for the panel (ADR-019): fetched with the Bearer like any other call and
      // shown from a blob: URL — no tokens in URLs. Untrusted bytes: inline only for images,
      // audio and PDF; nosniff + sandbox CSP always.
      method: "get",
      path: "/media/:id",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const media = await deps.conversationQuery.media(id);
        if (!media || media.status !== "stored") throw errors.notFound("Media not available");
        const bytes = await deps.mediaStorage.get(id);
        if (!bytes) throw errors.notFound("Media not available");
        res.set(
          mediaResponseHeaders({
            id,
            mimeType: media.mimeType,
            filename: media.filename,
            size: bytes.byteLength,
          }),
        );
        res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      },
    },
    {
      method: "get",
      path: "/conversations/:id/mode",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const view = await deps.mode.status({
          conversationId: getValidated<typeof idParams>(res, "params").id,
        });
        if (!view) throw errors.notFound("Conversation not found");
        res.json({ mode: view });
      },
    },
    {
      method: "post",
      path: "/conversations/:id/pause",
      roles: ALL_ROLES,
      schemas: { params: idParams, body: pauseBody },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const { minutes } = getValidated<typeof pauseBody>(res, "body");
        const result = await deps.mode.pause(
          { conversationId: id },
          { minutes },
          { userId: ctx.user.userId },
          ctx.log,
        );
        res.json({ mode: result.state, changed: result.decision.changed });
      },
    },
    {
      method: "post",
      path: "/conversations/:id/resume",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const result = await deps.mode.resume(
          { conversationId: id },
          { userId: ctx.user.userId },
          ctx.log,
        );
        res.json({ mode: result.state, changed: result.decision.changed });
      },
    },
    {
      method: "post",
      path: "/conversations/:id/reply",
      roles: ALL_ROLES,
      schemas: { params: idParams, body: replyBody },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const { text } = getValidated<typeof replyBody>(res, "body");
        const view = await deps.mode.status({ conversationId: id });
        if (!view) throw errors.notFound("Conversation not found");
        const sent = await deps.humanReply.reply(
          { conversationId: id },
          { text, userId: ctx.user.userId },
          { userId: ctx.user.userId },
          ctx.log,
        );
        // Allowed after an opt-out (a person, inside the window) — the panel shows a warning.
        const consent = await deps.consent.find({ contactId: view.contactId });
        res.status(201).json({
          messageId: sent.messageId,
          mode: sent.takeover.state,
          optedOut: consent?.optOutAt != null,
        });
      },
    },
    // ── Contacts: manual opt-out / opt-in (ADR-017) ─────────────────────────
    {
      method: "get",
      path: "/contacts/opted-out",
      roles: ALL_ROLES,
      handler: async (_req, res) => {
        res.json({ contacts: await deps.conversationQuery.optedOut() });
      },
    },
    {
      method: "get",
      path: "/contacts/:id/consent",
      roles: ALL_ROLES,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const view = await deps.consent.find({
          contactId: getValidated<typeof idParams>(res, "params").id,
        });
        if (!view) throw errors.notFound("Contact not found");
        res.json({ consent: view });
      },
    },
    ...(["opt-out", "opt-in"] as const).map((action): AdminRoute => ({
      method: "post",
      path: `/contacts/:id/${action}`,
      // Honoring a stop request is always safe; re-enabling messages is admin-only.
      roles: action === "opt-out" ? ALL_ROLES : ADMIN_ONLY,
      schemas: { params: idParams, body: consentBody },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const { reason, source } = getValidated<typeof consentBody>(res, "body");
        if (!(await deps.consent.find({ contactId: id })))
          throw errors.notFound("Contact not found");
        const result = await deps.consent.apply({
          contactId: id,
          kind: action === "opt-out" ? "opt_out" : "opt_in",
          method: source,
          actor: { userId: ctx.user.userId },
          note: reason,
          now: new Date(),
        });
        res.json({ changed: result.changed, consent: await deps.consent.find({ contactId: id }) });
      },
    })),
    // ── Settings ────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/settings",
      roles: ALL_ROLES,
      handler: async (_req, res, ctx) => {
        res.json({ settings: await deps.settings.getAll(ctx.log) });
      },
    },
    {
      // Operating status for the panel header (phase 9 M6): open / "fuera de horario" and the
      // global automatic-replies switch.
      method: "get",
      path: "/status",
      roles: ALL_ROLES,
      handler: async (_req, res, ctx) => {
        const all = await deps.settings.getAll(ctx.log);
        const hours = (all["businessHours"] ?? null) as BusinessHours | null;
        const now = new Date();
        const opening = nextOpening(hours, now);
        res.json({
          autoRepliesEnabled: all["bot.autoRepliesEnabled"] !== false,
          businessHours: {
            configured: hours !== null,
            open: isOpen(hours, now),
            nextOpening: opening && opening > now ? opening : null,
          },
        });
      },
    },
    {
      method: "put",
      path: "/settings/:key",
      roles: ADMIN_ONLY,
      schemas: { params: settingParams, body: settingBody },
      handler: async (_req, res, ctx) => {
        if (!deps.settings.set) throw new Error("settings are read-only in this app");
        const { key } = getValidated<typeof settingParams>(res, "params");
        const { value } = getValidated<typeof settingBody>(res, "body");
        const saved = await deps.settings.set(key, value, auditActor(ctx));
        res.json({ key: saved.key, value: saved.value });
      },
    },
    // ── Users (admin) ───────────────────────────────────────────────────────
    {
      method: "get",
      path: "/users",
      roles: ADMIN_ONLY,
      handler: async (_req, res) => {
        res.json({ users: await deps.users.list() });
      },
    },
    {
      method: "post",
      path: "/users",
      roles: ADMIN_ONLY,
      schemas: { body: createUserBody },
      handler: async (_req, res, ctx) => {
        const body = getValidated<typeof createUserBody>(res, "body");
        res.status(201).json({ user: await deps.users.create(body, auditActor(ctx)) });
      },
    },
    {
      method: "patch",
      path: "/users/:id",
      roles: ADMIN_ONLY,
      schemas: { params: idParams, body: patchUserBody },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const change = getValidated<typeof patchUserBody>(res, "body");
        res.json(await deps.users.update(id, change, auditActor(ctx)));
      },
    },
    {
      method: "post",
      path: "/users/:id/reset-password",
      roles: ADMIN_ONLY,
      schemas: { params: idParams, body: passwordBody },
      handler: async (_req, res, ctx) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        const { password } = getValidated<typeof passwordBody>(res, "body");
        res.json(await deps.users.resetPassword(id, password, auditActor(ctx)));
      },
    },
    {
      method: "post",
      path: "/users/:id/unlock",
      roles: ADMIN_ONLY,
      schemas: { params: idParams },
      handler: async (_req, res, ctx) => {
        await deps.users.unlock(getValidated<typeof idParams>(res, "params").id, auditActor(ctx));
        res.status(204).end();
      },
    },
    {
      method: "post",
      path: "/users/:id/revoke-sessions",
      roles: ADMIN_ONLY,
      schemas: { params: idParams },
      handler: async (_req, res) => {
        const { id } = getValidated<typeof idParams>(res, "params");
        await deps.users.assertModifiable(id);
        res.json({ sessions: await deps.sessions.revokeAllForUser(id, "revoked_by_admin") });
      },
    },
  ];
}

/** Method + path + roles of every admin route (used by the route-inventory test). */
export function adminRouteTable(deps: AdminDeps) {
  return buildRoutes(deps).map(({ method, path, roles }) => ({ method, path, roles }));
}

export function createAdminRouter(options: {
  deps: AdminDeps;
  authenticate: AuthService["authenticate"];
  logger: Logger;
}): Router {
  const router = Router();
  router.use(createRequireAuth(options.authenticate));
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  for (const route of buildRoutes(options.deps)) {
    router[route.method](
      route.path,
      requireRole(route.roles),
      ...(route.schemas ? [validate(route.schemas)] : []),
      async (req, res) => {
        const requestId = typeof req.id === "string" ? req.id : undefined;
        const user = currentUser(res);
        await route.handler(req, res, {
          user,
          log: options.logger.child({ requestId, userId: user.userId }),
          ...(requestId ? { requestId } : {}),
        });
      },
    );
  }
  return router;
}
