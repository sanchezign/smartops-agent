/**
 * Per-account lockout after failed logins (pure, phase 8, ADR-018 — OWASP Authentication
 * Cheat Sheet): 5 failures within 15 min lock the account for 15 min; each consecutive lock
 * doubles the duration, CAPPED AT 1 HOUR (user decision). A successful login resets
 * everything. The per-IP rate limit on /auth/login is a separate, outer layer; the cap and
 * the automatic expiry limit the denial-of-service an attacker can cause to a real user.
 */

export interface LockoutState {
  failedCount: number;
  /** First failure of the current observation window. */
  windowStartedAt: Date | null;
  lockedUntil: Date | null;
  /** Consecutive locks since the last success (drives the doubling). */
  lockLevel: number;
}

export const LOCKOUT = {
  threshold: 5,
  windowMs: 15 * 60_000,
  baseLockMs: 15 * 60_000,
  maxLockMs: 60 * 60_000,
} as const;

export const EMPTY_LOCKOUT: LockoutState = {
  failedCount: 0,
  windowStartedAt: null,
  lockedUntil: null,
  lockLevel: 0,
};

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function lockDurationMs(lockLevel: number): number {
  return Math.min(LOCKOUT.baseLockMs * 2 ** lockLevel, LOCKOUT.maxLockMs);
}

/** A failed attempt (also while locked: it does not extend the lock). */
export function registerFailure(
  state: LockoutState,
  now: Date,
): { next: LockoutState; lockedNow: boolean } {
  if (isLocked(state, now)) return { next: state, lockedNow: false };
  const windowExpired =
    state.windowStartedAt === null ||
    now.getTime() - state.windowStartedAt.getTime() > LOCKOUT.windowMs;
  const failedCount = windowExpired ? 1 : state.failedCount + 1;
  const windowStartedAt = windowExpired ? now : state.windowStartedAt;
  if (failedCount >= LOCKOUT.threshold) {
    return {
      next: {
        failedCount: 0,
        windowStartedAt: null,
        lockedUntil: new Date(now.getTime() + lockDurationMs(state.lockLevel)),
        lockLevel: state.lockLevel + 1,
      },
      lockedNow: true,
    };
  }
  return { next: { ...state, failedCount, windowStartedAt }, lockedNow: false };
}

export function registerSuccess(): LockoutState {
  return EMPTY_LOCKOUT;
}
