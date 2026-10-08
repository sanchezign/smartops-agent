import type { RequestHandler } from "express";
import { errors } from "../../common/errors/app-error.js";
import type { ReviewKind, ReviewScope, UserRole } from "../../generated/prisma/enums.js";
import { currentUser } from "./auth-http.js";

/**
 * Panel permissions (phase 8, ADR-018; user rules 2026-09-27):
 * - operator: line reviews, pause/resume the bot, reply as a person, manual opt-OUT.
 * - admin: everything, including run gates (scope "run"), catalog-wide proposals
 *   (global_change, mark_unavailable), manual opt-IN, settings writes and users.
 * - DEMO_MODE only (ADR-030, phase 14): an operator may also resolve the column-mapping review
 *   (scope "run", kind "column_mapping"), the step the public demo showcases. Nothing else changes.
 * Pure rules + middleware; the route table in admin.routes.ts declares the roles per route.
 */

export const ALL_ROLES: readonly UserRole[] = ["admin", "operator"];
export const ADMIN_ONLY: readonly UserRole[] = ["admin"];

/**
 * Who may approve or reject a review item. `demoMode` comes from the API configuration
 * (DEMO_MODE), never from a request; omitted = false = the phase 8 rule, unchanged.
 */
export function canResolveReview(
  role: UserRole,
  item: { scope: ReviewScope; kind: ReviewKind },
  options: { demoMode?: boolean } = {},
): boolean {
  if (role === "admin") return true;
  if (item.scope === "line") return true;
  return options.demoMode === true && item.scope === "run" && item.kind === "column_mapping";
}

export function requireRole(roles: readonly UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const { role } = currentUser(res);
    if (!roles.includes(role)) return next(errors.forbidden("Your role cannot do this"));
    next();
  };
}
