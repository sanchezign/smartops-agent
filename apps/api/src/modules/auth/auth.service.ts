import { errors } from "../../common/errors/app-error.js";
import type { AppLocale } from "../../common/locale.js";
import type { Logger } from "../../common/logger.js";
import {
  NO_PUBLIC_ACCOUNT,
  PUBLIC_ACCOUNT_REFUSED,
  type PublicAccount,
} from "../demo/public-account.js";
import type { UsersRepository } from "../users/users.repository.js";
import { emailSchema } from "../users/users.service.js";
import { isLocked, registerFailure, registerSuccess } from "./login-lockout.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password.js";
import type { SessionConfig, SessionUser, SessionsRepository } from "./sessions.repository.js";
import type { AccessTokens } from "./tokens.js";

/**
 * Panel login / refresh / logout (phase 8, ADR-018).
 * - One generic error for every failed login (unknown email, wrong password, locked,
 *   inactive), with the same work done in every case (a dummy Argon2 check for unknown
 *   emails) — no user enumeration by message or timing.
 * - Refresh rotates the token; reuse of a rotated one revokes the whole session.
 * - Every outcome is audited; tokens and passwords never are.
 */

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

export interface AuthenticatedUser {
  userId: string;
  role: SessionUser["role"];
  email: string;
  name: string;
  sessionId: string;
  /** Panel language (phase 13); absent/null = follow the browser. */
  locale?: AppLocale | null;
}

const INVALID_LOGIN = "Invalid email or password";

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export function createAuthService(deps: {
  users: Pick<
    UsersRepository,
    "findByEmail" | "saveLockout" | "setPassword" | "audit" | "setLocale"
  >;
  sessions: SessionsRepository;
  tokens: AccessTokens;
  config: SessionConfig;
  now?: () => Date;
  /** The shared public demo operator (DEMO_MODE): never locked, no logout-all. */
  publicAccount?: PublicAccount;
}) {
  const now = deps.now ?? (() => new Date());
  const publicAccount = deps.publicAccount ?? NO_PUBLIC_ACCOUNT;

  async function issue(
    user: SessionUser,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ) {
    const accessToken = await deps.tokens.sign(
      { sub: user.id, role: user.role, sid: sessionId },
      now(),
    );
    return {
      accessToken,
      expiresIn: deps.tokens.ttlSeconds,
      refreshToken,
      refreshExpiresAt,
      user,
    } satisfies IssuedSession;
  }

  const audit = (
    action: string,
    meta: RequestMeta,
    entry: { userId?: string; entityId?: string | null; data?: Record<string, unknown> },
  ) =>
    deps.users.audit(
      {
        action,
        entityId: entry.entityId ?? entry.userId ?? null,
        ...(entry.data ? { data: entry.data } : {}),
      },
      {
        ...(entry.userId ? { userId: entry.userId } : {}),
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
      },
    );

  return {
    async login(input: { email: string; password: string }, meta: RequestMeta, log: Logger) {
      const parsed = emailSchema.safeParse(input.email);
      const email = parsed.success ? parsed.data : input.email.trim().toLowerCase();
      const at = now();
      const user = parsed.success ? await deps.users.findByEmail(email) : null;

      if (!user) {
        await burnPasswordCheck(input.password);
        await audit("auth.login_failed", meta, {
          data: { reason: "unknown_email", email: maskEmail(email), ip: meta.ip ?? null },
        });
        throw errors.unauthorized(INVALID_LOGIN);
      }

      const check = await verifyPassword(user.passwordHash, input.password);
      // The shared public demo account is never locked: a lock would hit every visitor
      // (5 wrong passwords = a trivial DoS). The per-IP login limiter protects it instead.
      const shared = publicAccount.isPublic(user.email);
      const locked = !shared && isLocked(user.lockout, at);
      if (!user.active || locked || !check.ok) {
        const reason = !user.active ? "inactive" : locked ? "locked" : "wrong_password";
        if (reason === "wrong_password" && !shared) {
          const { next, lockedNow } = registerFailure(user.lockout, at);
          await deps.users.saveLockout(user.id, next);
          if (lockedNow) {
            await audit("auth.account_locked", meta, {
              userId: user.id,
              data: { until: next.lockedUntil?.toISOString(), level: next.lockLevel },
            });
            log.warn({ userId: user.id }, "panel account locked after failed logins");
          }
        }
        await audit("auth.login_failed", meta, {
          userId: user.id,
          data: { reason, ip: meta.ip ?? null },
        });
        throw errors.unauthorized(INVALID_LOGIN);
      }

      await deps.users.saveLockout(user.id, registerSuccess(), { lastLoginAt: at });
      if (check.needsRehash) {
        await deps.users.setPassword(
          user.id,
          await hashPassword(input.password),
          {},
          {
            revokeSessions: false,
            audit: false,
          },
        );
      }
      const session = await deps.sessions.create(
        user.id,
        { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        at,
        deps.config,
      );
      await audit("auth.login_succeeded", meta, {
        userId: user.id,
        data: { sessionId: session.sessionId, ip: meta.ip ?? null },
      });
      const sessionUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        locale: user.locale,
      };
      return issue(sessionUser, session.sessionId, session.refreshToken, session.expiresAt);
    },

    async refresh(refreshToken: string | undefined, meta: RequestMeta, log: Logger) {
      if (!refreshToken) throw errors.unauthorized("No session");
      const result = await deps.sessions.refresh(refreshToken, now(), deps.config);
      switch (result.kind) {
        case "rotated":
          return issue(result.user, result.sessionId, result.refreshToken, result.expiresAt);
        case "race":
          throw errors.refreshRace();
        case "reuse":
          await audit("auth.refresh_reuse_detected", meta, {
            userId: result.userId,
            data: { sessionId: result.sessionId, ip: meta.ip ?? null },
          });
          log.warn(
            { sessionId: result.sessionId, userId: result.userId },
            "refresh token reuse detected: session revoked",
          );
          throw errors.unauthorized("Session revoked");
        default:
          throw errors.unauthorized("Session expired");
      }
    },

    async logout(refreshToken: string | undefined, meta: RequestMeta) {
      if (!refreshToken) return;
      const found = await deps.sessions.sessionOfToken(refreshToken);
      if (!found) return;
      if (await deps.sessions.revoke(found.sessionId, "logout", now())) {
        await audit("auth.logout", meta, {
          userId: found.userId,
          data: { sessionId: found.sessionId },
        });
      }
    },

    /**
     * The user's panel language (phase 13). The shared public demo operator cannot store one:
     * it would switch the language of every other visitor (the panel keeps it in a cookie).
     */
    async setLocale(user: { userId: string; email: string }, locale: AppLocale | null) {
      if (publicAccount.isPublic(user.email)) throw errors.forbidden(PUBLIC_ACCOUNT_REFUSED);
      await deps.users.setLocale(user.userId, locale);
    },

    async logoutAll(user: { userId: string; email: string }, meta: RequestMeta) {
      // It would end every OTHER visitor's session of the shared public demo account.
      if (publicAccount.isPublic(user.email)) throw errors.forbidden(PUBLIC_ACCOUNT_REFUSED);
      const userId = user.userId;
      const count = await deps.sessions.revokeAllForUser(userId, "logout_all");
      await audit("auth.logout_all", meta, { userId, data: { sessions: count } });
      return count;
    },

    /**
     * Is this session still alive, and with which role? For long-lived connections (SSE,
     * ADR-020) whose access token may expire while the session stays valid: logout-all,
     * idle/absolute expiry, deactivation and role changes are seen on the next heartbeat.
     */
    async checkSession(
      sessionId: string,
    ): Promise<{ userId: string; role: SessionUser["role"] } | null> {
      const active = await deps.sessions.findActive(sessionId, now());
      return active ? { userId: active.user.id, role: active.user.role } : null;
    },

    /** Bearer → the live session and user (role from the DB, not from the token). */
    async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
      const claims = await deps.tokens.verify(accessToken, now());
      if (!claims) return null;
      const active = await deps.sessions.findActive(claims.sid, now());
      if (!active || active.user.id !== claims.sub) return null;
      return {
        userId: active.user.id,
        role: active.user.role,
        email: active.user.email,
        name: active.user.name,
        sessionId: active.sessionId,
        locale: active.user.locale,
      };
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
