/**
 * Refresh-token rotation decision (pure, phase 8, ADR-018 — RFC 9700 §4.14.2): every refresh
 * consumes the token and issues a new one in the same session ("family"). Presenting a token
 * that was ALREADY rotated means it was copied: the whole session is revoked — except a short
 * grace for the token rotated just now, which is what two panel tabs refreshing at the same
 * time look like (same cookie sent twice in a few milliseconds).
 */

export const REFRESH_RACE_GRACE_MS = 10_000;

export interface RefreshTokenState {
  rotatedAt: Date | null;
  /** This is the most recently rotated token of its session (its successor is the current one). */
  isLatestRotated: boolean;
}

export interface SessionState {
  revokedAt: Date | null;
  idleExpiresAt: Date;
  expiresAt: Date;
  userActive: boolean;
}

export type RefreshDecision =
  | { action: "rotate" }
  /** Reuse of an old token: revoke the whole session. */
  | { action: "revoke_reuse" }
  /** Concurrent refresh with the same cookie: tell the client to retry, revoke nothing. */
  | { action: "race" }
  | { action: "reject"; reason: "revoked" | "expired" | "idle_expired" | "user_inactive" };

export function decideRefresh(
  token: RefreshTokenState,
  session: SessionState,
  now: Date,
): RefreshDecision {
  if (session.revokedAt) return { action: "reject", reason: "revoked" };
  if (!session.userActive) return { action: "reject", reason: "user_inactive" };
  if (session.expiresAt.getTime() <= now.getTime()) return { action: "reject", reason: "expired" };
  if (session.idleExpiresAt.getTime() <= now.getTime())
    return { action: "reject", reason: "idle_expired" };
  if (token.rotatedAt === null) return { action: "rotate" };
  const age = now.getTime() - token.rotatedAt.getTime();
  if (token.isLatestRotated && age >= 0 && age <= REFRESH_RACE_GRACE_MS) return { action: "race" };
  return { action: "revoke_reuse" };
}

/** New idle deadline after a successful refresh, never beyond the absolute end. */
export function nextIdleExpiry(now: Date, idleHours: number, expiresAt: Date): Date {
  const idle = now.getTime() + idleHours * 3_600_000;
  return new Date(Math.min(idle, expiresAt.getTime()));
}
