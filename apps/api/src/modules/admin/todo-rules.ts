import { ReviewKind, ReviewScope, type UserRole } from "../../generated/prisma/enums.js";
import { canResolveReview } from "../auth/permissions.js";

/**
 * To do (phase 15, ADR-032): pure rules of the read model. The permission rule is NOT restated
 * here: every (scope, kind) group of pending reviews goes through `canResolveReview`, the same
 * function the approve / reject handlers use (ADR-018, ADR-030).
 */

/** Lists (ingestion runs) returned by GET /admin/todo; more → `groupsTruncated`. */
export const TODO_GROUP_LIMIT = 50;
/** Review items returned per list (the rest via GET /admin/reviews?runId=…). */
export const TODO_ITEMS_PER_GROUP = 5;
/** Open action alerts returned (the count is always exact). */
export const TODO_ALERT_LIMIT = 50;

export interface PendingKindCount {
  scope: ReviewScope;
  kind: ReviewKind;
  count: number;
}

export interface Viewer {
  role: UserRole;
  demoMode: boolean;
}

export interface ReviewSplit {
  /** Pending items this user may approve / reject. */
  canResolve: number;
  /** Pending items only an admin may resolve (shown folded, without yellow). */
  waitingForAdmin: number;
}

/**
 * Every (scope, kind) this viewer may resolve, enumerated through canResolveReview — so SQL can
 * tell "mine" from "waits for an admin" without restating the rule.
 */
export function resolvablePairs(viewer: Viewer): { scope: ReviewScope; kind: ReviewKind }[] {
  return Object.values(ReviewScope).flatMap((scope) =>
    Object.values(ReviewKind)
      .filter((kind) =>
        canResolveReview(viewer.role, { scope, kind }, { demoMode: viewer.demoMode }),
      )
      .map((kind) => ({ scope, kind })),
  );
}

export function splitPending(groups: readonly PendingKindCount[], viewer: Viewer): ReviewSplit {
  let canResolve = 0;
  let waitingForAdmin = 0;
  for (const g of groups) {
    if (canResolveReview(viewer.role, g, { demoMode: viewer.demoMode })) canResolve += g.count;
    else waitingForAdmin += g.count;
  }
  return { canResolve, waitingForAdmin };
}

export interface TodoCounts {
  /** The ONE yellow counter of the navigation: what this user can resolve + action alerts. */
  total: number;
  reviews: ReviewSplit;
  /** Open action alerts (acknowledging is allowed to every role). */
  alerts: number;
}

export function todoCounts(reviews: ReviewSplit, actionAlerts: number): TodoCounts {
  return { total: reviews.canResolve + actionAlerts, reviews, alerts: actionAlerts };
}
