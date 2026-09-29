import { Router } from "express";
import { APP_LOCALES } from "../../common/locale.js";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AppError, errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { getValidated, validate } from "../../common/middleware/validate.js";
import type { Env } from "../../config/env.js";
import {
  clearRefreshCookie,
  createCsrfGuard,
  createRequireAuth,
  currentUser,
  readCookie,
  refreshCookieConfig,
  requestMeta,
  setRefreshCookie,
} from "./auth-http.js";
import type { AuthService, IssuedSession } from "./auth.service.js";

/**
 * /api/v1/auth (phase 8, ADR-018):
 *   POST /login       {email, password} → {accessToken, expiresIn, user} + refresh cookie
 *   POST /refresh     cookie → new access token + rotated cookie (409 REFRESH_RACE: retry)
 *   POST /logout      ends this session (always 204)
 *   POST /logout-all  Bearer → ends every session of the user
 *   GET  /me          Bearer → the current user
 * The cookie routes need the CSRF header + an allowed Origin. Nothing here is cached.
 */

const loginBody = z
  .object({
    email: z.string().max(254),
    // Upper bound only against huge inputs (Argon2 cost); the policy lives in users.
    password: z.string().min(1).max(1024),
  })
  .strict();

export function createAuthRouter(deps: {
  service: AuthService;
  env: Pick<
    Env,
    | "NODE_ENV"
    | "CORS_ORIGINS"
    | "AUTH_COOKIE_SAMESITE"
    | "AUTH_COOKIE_SECURE"
    | "AUTH_COOKIE_PARTITIONED"
    | "LOGIN_RATE_LIMIT_MAX"
  >;
  logger: Logger;
}): Router {
  const router = Router();
  const cookie = refreshCookieConfig(deps.env);
  const csrf = createCsrfGuard({
    allowedOrigins: deps.env.CORS_ORIGINS,
    sameSite: deps.env.AUTH_COOKIE_SAMESITE,
  });
  const requireAuth = createRequireAuth(deps.service.authenticate);
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: deps.env.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(errors.rateLimited()),
  });

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const sendSession = (res: Parameters<typeof setRefreshCookie>[0], session: IssuedSession) => {
    setRefreshCookie(res, cookie, session.refreshToken, session.refreshExpiresAt);
    res.json({
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    });
  };

  router.post("/login", loginLimiter, csrf, validate({ body: loginBody }), async (req, res) => {
    const body = getValidated<typeof loginBody>(res, "body");
    const log = deps.logger.child({ requestId: req.id });
    sendSession(res, await deps.service.login(body, requestMeta(req), log));
  });

  router.post("/refresh", csrf, async (req, res) => {
    const log = deps.logger.child({ requestId: req.id });
    try {
      sendSession(
        res,
        await deps.service.refresh(readCookie(req, cookie.name), requestMeta(req), log),
      );
    } catch (err) {
      // A dead session: drop the cookie so the panel goes back to the login page.
      if (err instanceof AppError && err.code === "UNAUTHORIZED") clearRefreshCookie(res, cookie);
      throw err;
    }
  });

  router.post("/logout", csrf, async (req, res) => {
    await deps.service.logout(readCookie(req, cookie.name), requestMeta(req));
    clearRefreshCookie(res, cookie);
    res.status(204).end();
  });

  router.post("/logout-all", requireAuth, async (req, res) => {
    const sessions = await deps.service.logoutAll(currentUser(res), requestMeta(req));
    clearRefreshCookie(res, cookie);
    res.json({ sessions });
  });

  router.get("/me", requireAuth, (_req, res) => {
    const { userId, email, name, role, locale } = currentUser(res);
    res.json({ user: { id: userId, email, name, role, locale: locale ?? null } });
  });

  // Phase 13: the user's panel language (Bearer only — not a cookie route, no CSRF needed).
  const preferencesBody = z.object({ locale: z.enum(APP_LOCALES).nullable() }).strict();
  router.patch("/me", requireAuth, validate({ body: preferencesBody }), async (_req, res) => {
    const user = currentUser(res);
    const { locale } = getValidated<typeof preferencesBody>(res, "body");
    await deps.service.setLocale(user, locale);
    res.json({
      user: { id: user.userId, email: user.email, name: user.name, role: user.role, locale },
    });
  });

  return router;
}
