import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { errors } from "../../common/errors/app-error.js";
import type { Env } from "../../config/env.js";
import type { AuthenticatedUser, AuthService, RequestMeta } from "./auth.service.js";

/**
 * HTTP pieces of panel auth (phase 8, ADR-018): the refresh cookie, the CSRF guard for the
 * cookie-authenticated routes and the Bearer middleware for everything else.
 */

/** The refresh cookie only travels to the auth routes. */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
export const CSRF_HEADER = "x-smartops-csrf";

export interface RefreshCookieConfig {
  name: string;
  options: CookieOptions;
}

export function refreshCookieConfig(
  env: Pick<
    Env,
    "NODE_ENV" | "AUTH_COOKIE_SAMESITE" | "AUTH_COOKIE_SECURE" | "AUTH_COOKIE_PARTITIONED"
  >,
): RefreshCookieConfig {
  const secure =
    env.AUTH_COOKIE_SECURE === "true" ||
    (env.AUTH_COOKIE_SECURE === "auto" && env.NODE_ENV === "production");
  return {
    // "__Secure-" makes the browser refuse the cookie unless it is Secure (HTTPS).
    name: secure ? "__Secure-smartops_rt" : "smartops_rt",
    options: {
      httpOnly: true,
      secure,
      sameSite: env.AUTH_COOKIE_SAMESITE,
      path: REFRESH_COOKIE_PATH,
      ...(env.AUTH_COOKIE_PARTITIONED ? { partitioned: true } : {}),
    },
  };
}

/** Reads one cookie from the raw header (no cookie-parser dependency for a single cookie). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setRefreshCookie(
  res: Response,
  config: RefreshCookieConfig,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(config.name, token, { ...config.options, expires: expiresAt });
}

export function clearRefreshCookie(res: Response, config: RefreshCookieConfig): void {
  res.clearCookie(config.name, config.options);
}

/**
 * CSRF for the routes that use the cookie (login, refresh, logout) — OWASP CSRF cheat sheet:
 * 1. a custom header (a cross-origin page cannot send it without a CORS preflight we refuse);
 * 2. Origin must be an allowed panel origin or this API's own origin;
 * 3. in same-origin / same-site modes, `Sec-Fetch-Site: cross-site` is rejected outright.
 * Bearer-authenticated routes need none of this (browsers never attach a Bearer by themselves).
 */
export function createCsrfGuard(options: {
  allowedOrigins: readonly string[];
  sameSite: Env["AUTH_COOKIE_SAMESITE"];
}): RequestHandler {
  const allowed = new Set(options.allowedOrigins);
  return (req, _res, next) => {
    if (req.get(CSRF_HEADER) !== "1") return next(errors.forbidden("Missing CSRF header"));
    const origin = req.get("origin");
    const own = `${req.protocol}://${req.get("host")}`;
    if (!origin || (origin !== own && !allowed.has(origin)))
      return next(errors.forbidden("Origin not allowed"));
    if (options.sameSite !== "none" && req.get("sec-fetch-site") === "cross-site")
      return next(errors.forbidden("Cross-site request refused"));
    next();
  };
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    ...(typeof req.id === "string" ? { requestId: req.id } : {}),
  };
}

/** `Authorization: Bearer <access token>` → res.locals.auth; 401 otherwise. */
export function createRequireAuth(authenticate: AuthService["authenticate"]): RequestHandler {
  return async (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) return next(errors.unauthorized("Missing access token"));
    try {
      const auth = await authenticate(match[1] as string);
      if (!auth) return next(errors.unauthorized("Invalid or expired access token"));
      res.locals.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function currentUser(res: Response): AuthenticatedUser {
  const auth = res.locals.auth as AuthenticatedUser | undefined;
  if (!auth) throw errors.unauthorized();
  return auth;
}
