import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { UserRole } from "../../generated/prisma/enums.js";
import { decideRefresh, nextIdleExpiry, type RefreshDecision } from "./session-rules.js";
import { hashRefreshToken, newRefreshToken } from "./tokens.js";

/**
 * Panel sessions and refresh tokens (phase 8, ADR-018). Only SHA-256 hashes of refresh tokens
 * are stored. A refresh locks the token row (SELECT … FOR UPDATE), so two concurrent refreshes
 * with the same cookie are serialized: the first rotates, the second sees it rotated.
 */

export interface SessionConfig {
  idleHours: number;
  maxDays: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
}

export type RefreshResult =
  | {
      kind: "rotated";
      sessionId: string;
      user: SessionUser;
      refreshToken: string;
      expiresAt: Date;
    }
  | { kind: "reuse"; sessionId: string; userId: string }
  | { kind: "race" }
  | { kind: "rejected"; reason: Extract<RefreshDecision, { action: "reject" }>["reason"] }
  | { kind: "unknown" };

export interface SessionsRepository {
  create(
    userId: string,
    meta: { userAgent?: string | null; ip?: string | null },
    now: Date,
    config: SessionConfig,
  ): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }>;
  refresh(refreshToken: string, now: Date, config: SessionConfig): Promise<RefreshResult>;
  /** The session a refresh token belongs to (for logout), whatever its state. */
  sessionOfToken(refreshToken: string): Promise<{ sessionId: string; userId: string } | null>;
  findActive(sessionId: string, now: Date): Promise<ActiveSession | null>;
  revoke(sessionId: string, reason: string, now: Date): Promise<boolean>;
  revokeAllForUserInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: string,
  ): Promise<number>;
  revokeAllForUser(userId: string, reason: string): Promise<number>;
}

const userSelect = { id: true, email: true, name: true, role: true, active: true } as const;

function toSessionUser(u: SessionUser & { active: boolean }): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export function createSessionsRepository(prisma: PrismaClient): SessionsRepository {
  async function revokeAllForUserInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: string,
  ): Promise<number> {
    const result = await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count;
  }

  return {
    async create(userId, meta, now, config) {
      const refreshToken = newRefreshToken();
      const expiresAt = new Date(now.getTime() + config.maxDays * 24 * 3_600_000);
      const session = await prisma.authSession.create({
        data: {
          userId,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: nextIdleExpiry(now, config.idleHours, expiresAt),
          expiresAt,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
          ip: meta.ip ?? null,
          refreshTokens: { create: { tokenHash: hashRefreshToken(refreshToken), createdAt: now } },
        },
        select: { id: true },
      });
      return { sessionId: session.id, refreshToken, expiresAt };
    },

    async refresh(refreshToken, now, config) {
      const tokenHash = hashRefreshToken(refreshToken);
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; session_id: string; rotated_at: Date | null }[]
        >`SELECT id, session_id, rotated_at FROM refresh_tokens
           WHERE token_hash = ${tokenHash} FOR UPDATE`;
        const token = rows[0];
        if (!token) return { kind: "unknown" as const };
        const session = await tx.authSession.findUniqueOrThrow({
          where: { id: token.session_id },
          select: {
            id: true,
            revokedAt: true,
            idleExpiresAt: true,
            expiresAt: true,
            user: { select: userSelect },
          },
        });
        const newerRotated = token.rotated_at
          ? await tx.refreshToken.count({
              where: { sessionId: session.id, rotatedAt: { gt: token.rotated_at } },
            })
          : 0;
        const decision = decideRefresh(
          { rotatedAt: token.rotated_at, isLatestRotated: newerRotated === 0 },
          {
            revokedAt: session.revokedAt,
            idleExpiresAt: session.idleExpiresAt,
            expiresAt: session.expiresAt,
            userActive: session.user.active,
          },
          now,
        );
        switch (decision.action) {
          case "reject":
            return { kind: "rejected" as const, reason: decision.reason };
          case "race":
            return { kind: "race" as const };
          case "revoke_reuse":
            await tx.authSession.update({
              where: { id: session.id },
              data: { revokedAt: now, revokeReason: "refresh_reuse" },
            });
            return { kind: "reuse" as const, sessionId: session.id, userId: session.user.id };
          case "rotate": {
            const next = newRefreshToken();
            await tx.refreshToken.update({ where: { id: token.id }, data: { rotatedAt: now } });
            await tx.refreshToken.create({
              data: { sessionId: session.id, tokenHash: hashRefreshToken(next), createdAt: now },
            });
            await tx.authSession.update({
              where: { id: session.id },
              data: {
                lastUsedAt: now,
                idleExpiresAt: nextIdleExpiry(now, config.idleHours, session.expiresAt),
              },
            });
            const user = toSessionUser(session.user);
            return {
              kind: "rotated" as const,
              sessionId: session.id,
              user,
              refreshToken: next,
              expiresAt: session.expiresAt,
            };
          }
        }
      });
    },

    async sessionOfToken(refreshToken) {
      const row = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        select: { session: { select: { id: true, userId: true } } },
      });
      return row ? { sessionId: row.session.id, userId: row.session.userId } : null;
    },

    async findActive(sessionId, now) {
      const session = await prisma.authSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          revokedAt: true,
          idleExpiresAt: true,
          expiresAt: true,
          user: { select: userSelect },
        },
      });
      if (
        !session ||
        session.revokedAt ||
        !session.user.active ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.idleExpiresAt.getTime() <= now.getTime()
      )
        return null;
      const user = toSessionUser(session.user);
      return { sessionId: session.id, user };
    },

    async revoke(sessionId, reason, now) {
      const result = await prisma.authSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now, revokeReason: reason },
      });
      return result.count > 0;
    },

    revokeAllForUserInTx,
    revokeAllForUser: (userId, reason) =>
      prisma.$transaction((tx) => revokeAllForUserInTx(tx, userId, reason)),
  };
}
