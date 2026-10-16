import type { RequestHandler } from "express";
import { errors } from "../../common/errors/app-error.js";
import type { ReviewKind, ReviewScope, UserRole } from "../../generated/prisma/enums.js";
import { currentUser } from "./auth-http.js";

/**
 * Panel permissions (phase 8, ADR-018; user rules 2026-09-27):
 * - operator: line reviews, pause/resume the bot, reply as a person, manual opt-OUT.
 * - admin: everything, including run gates (scope "run"), catalog-wide proposals
 *   (global_change, mark_unavailable), manual opt-IN, settings writes and users.
 * - DEMO_MODE only (ADR-034, phase 16; it extends ADR-030): an operator may resolve EVERY review,
 *   so a visitor of the public demo can try all of them without a public admin account. Only the
 *   item-level rule changes: users, settings writes and manual opt-in stay admin-only routes.
 *   With DEMO_MODE off the table is the phase 8 one, frozen in
 *   test/fixtures/review-permissions-demo-off.json.
 * Pure rules + middleware; the route table in admin.routes.ts declares the roles per route.
 */

export const ALL_ROLES: readonly UserRole[] = ["admin", "operator"];
export const ADMIN_ONLY: readonly UserRole[] = ["admin"];

/**
 * Who may approve or reject a review item. `demoMode` comes from the API configuration
 * (env.DEMO_MODE, read once at startup), NEVER from a request (header, query, body or cookie);
 * omitted = false = the phase 8 rule, unchanged.
 */
export function canResolveReview(
  role: UserRole,
  item: { scope: ReviewScope; kind: ReviewKind },
  options: { demoMode?: boolean } = {},
): boolean {
  if (role === "admin") return true;
  if (item.scope === "line") return true;
  // ADR-034: in the public demo the operator resolves the rest too (run gates, catalog-wide).
  return options.demoMode === true;
}

export function requireRole(roles: readonly UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const { role } = currentUser(res);
    if (!roles.includes(role)) return next(errors.forbidden("Your role cannot do this"));
    next();
  };
}
