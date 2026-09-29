import type { PrismaClient } from "../../common/db.js";
import { toAppLocale, type AppLocale } from "../../common/locale.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { UserRole } from "../../generated/prisma/enums.js";
import type { LockoutState } from "../auth/login-lockout.js";

/**
 * Users (phase 8, ADR-018). The only place that touches the `users` table and the user
 * audit trail. Role / active changes run under an advisory lock so two admins can never
 * demote each other at the same time and leave the system without an active admin.
 */

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  /** Panel language (phase 13); null = follow the browser. */
  locale: AppLocale | null;
  passwordHash: string;
  lockout: LockoutState;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
}

export type PublicUser = Omit<UserRecord, "passwordHash" | "lockout" | "locale"> & {
  lockedUntil: Date | null;
};

export interface AuditActor {
  userId?: string;
  /** e.g. "cli:ana" when there is no user (scripts). */
  label?: string;
  requestId?: string;
}

export interface AuditEntry {
  action: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/** Revokes every session of a user inside the caller's transaction (wired in M3). */
export type RevokeUserSessionsInTx = (
  tx: Prisma.TransactionClient,
  userId: string,
  reason: string,
) => Promise<number>;

export interface UsersRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  /** The user's panel language (phase 13). Not audited: a display preference. */
  setLocale(id: string, locale: AppLocale | null): Promise<void>;
  findById(id: string): Promise<UserRecord | null>;
  list(): Promise<PublicUser[]>;
  create(
    input: { email: string; name: string; role: UserRole; passwordHash: string },
    actor: AuditActor,
  ): Promise<PublicUser>;
  /** Role / active change; returns null when it would leave no active admin. */
  update(
    id: string,
    change: { role?: UserRole; active?: boolean },
    actor: AuditActor,
  ): Promise<{ user: PublicUser; revokedSessions: number } | "last_admin" | "not_found">;
  setPassword(
    id: string,
    passwordHash: string,
    actor: AuditActor,
    options: { revokeSessions: boolean; audit: boolean },
  ): Promise<number>;
  saveLockout(id: string, state: LockoutState, extra?: { lastLoginAt?: Date }): Promise<void>;
  audit(entry: AuditEntry, actor: AuditActor): Promise<void>;
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  locale: true,
  passwordHash: true,
  failedLoginCount: true,
  loginWindowStartedAt: true,
  lockedUntil: true,
  lockLevel: true,
  lastLoginAt: true,
  passwordChangedAt: true,
  createdAt: true,
} as const;

type Row = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function toRecord(row: Row): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    locale: toAppLocale(row.locale),
    passwordHash: row.passwordHash,
    lockout: {
      failedCount: row.failedLoginCount,
      windowStartedAt: row.loginWindowStartedAt,
      lockedUntil: row.lockedUntil,
      lockLevel: row.lockLevel,
    },
    lastLoginAt: row.lastLoginAt,
    passwordChangedAt: row.passwordChangedAt,
    createdAt: row.createdAt,
  };
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
    createdAt: user.createdAt,
    lockedUntil: user.lockout.lockedUntil,
  };
}

function auditData(entry: AuditEntry, actor: AuditActor): Prisma.AuditLogUncheckedCreateInput {
  return {
    actorType: actor.userId ? "user" : "system",
    userId: actor.userId ?? null,
    action: entry.action,
    entity: "user",
    entityId: entry.entityId ?? null,
    data: {
      ...(entry.data ?? {}),
      ...(actor.label ? { actor: actor.label } : {}),
    } as Prisma.InputJsonValue,
    requestId: actor.requestId ?? null,
  };
}

export function createUsersRepository(
  prisma: PrismaClient,
  deps: { revokeUserSessionsInTx?: RevokeUserSessionsInTx } = {},
): UsersRepository {
  const revoke = async (tx: Prisma.TransactionClient, userId: string, reason: string) =>
    deps.revokeUserSessionsInTx ? deps.revokeUserSessionsInTx(tx, userId, reason) : 0;

  return {
    async setLocale(id, locale) {
      await prisma.user.update({ where: { id }, data: { locale } });
    },

    async findByEmail(email) {
      const row = await prisma.user.findUnique({ where: { email }, select: userSelect });
      return row ? toRecord(row) : null;
    },

    async findById(id) {
      const row = await prisma.user.findUnique({ where: { id }, select: userSelect });
      return row ? toRecord(row) : null;
    },

    async list() {
      const rows = await prisma.user.findMany({
        select: userSelect,
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => toPublicUser(toRecord(row)));
    },

    async create(input, actor) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.user.create({
          data: { ...input, passwordChangedAt: new Date() },
          select: userSelect,
        });
        await tx.auditLog.create({
          data: auditData(
            { action: "user.created", entityId: row.id, data: { role: row.role } },
            actor,
          ),
        });
        return toPublicUser(toRecord(row));
      });
    },

    async update(id, change, actor) {
      return prisma.$transaction(async (tx) => {
        // One admin-changing transaction at a time (last-admin rule).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('users:admins'))`;
        const current = await tx.user.findUnique({ where: { id }, select: userSelect });
        if (!current) return "not_found" as const;
        const nextRole = change.role ?? current.role;
        const nextActive = change.active ?? current.active;
        const losesAdmin =
          current.role === "admin" && current.active && (nextRole !== "admin" || !nextActive);
        if (losesAdmin) {
          const otherAdmins = await tx.user.count({
            where: { role: "admin", active: true, id: { not: id } },
          });
          if (otherAdmins === 0) return "last_admin" as const;
        }
        const row = await tx.user.update({
          where: { id },
          data: { role: nextRole, active: nextActive },
          select: userSelect,
        });
        let revokedSessions = 0;
        if (nextRole !== current.role) {
          await tx.auditLog.create({
            data: auditData(
              {
                action: "user.role_changed",
                entityId: id,
                data: { from: current.role, to: nextRole },
              },
              actor,
            ),
          });
        }
        if (nextActive !== current.active) {
          await tx.auditLog.create({
            data: auditData(
              { action: nextActive ? "user.reactivated" : "user.deactivated", entityId: id },
              actor,
            ),
          });
        }
        // Any privilege change (or deactivation) ends every open session of that user.
        if (nextRole !== current.role || (current.active && !nextActive)) {
          revokedSessions = await revoke(tx, id, nextActive ? "role_changed" : "user_deactivated");
        }
        return { user: toPublicUser(toRecord(row)), revokedSessions };
      });
    },

    async setPassword(id, passwordHash, actor, options) {
      return prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id },
          data: {
            passwordHash,
            passwordChangedAt: new Date(),
            failedLoginCount: 0,
            loginWindowStartedAt: null,
            lockedUntil: null,
            lockLevel: 0,
          },
        });
        if (options.audit) {
          await tx.auditLog.create({
            data: auditData({ action: "user.password_reset", entityId: id }, actor),
          });
        }
        return options.revokeSessions ? revoke(tx, id, "password_changed") : 0;
      });
    },

    async saveLockout(id, state, extra = {}) {
      await prisma.user.update({
        where: { id },
        data: {
          failedLoginCount: state.failedCount,
          loginWindowStartedAt: state.windowStartedAt,
          lockedUntil: state.lockedUntil,
          lockLevel: state.lockLevel,
          ...(extra.lastLoginAt ? { lastLoginAt: extra.lastLoginAt } : {}),
        },
      });
    },

    async audit(entry, actor) {
      await prisma.auditLog.create({ data: auditData(entry, actor) });
    },
  };
}
