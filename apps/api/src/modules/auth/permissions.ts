import type { RequestHandler } from "express";
import { errors } from "../../common/errors/app-error.js";
import type { ReviewKind, ReviewScope, UserRole } from "../../generated/prisma/enums.js";
import { currentUser } from "./auth-http.js";

/**
 * Panel permissions (phase 8, ADR-018; user rules 2026-09-27):
 * - operator: line reviews, pause/resume the bot, reply as a person, manual opt-OUT.
 * - admin: everything, including run gates (scope "run"), catalog-wide proposals
 *   (global_change, mark_unavailable), manual opt-IN, settings writes and users.
 * Pure rules + middleware; the route table in admin.routes.ts declares the roles per route.
 */

export const ALL_ROLES: readonly UserRole[] = ["admin", "operator"];
export const ADMIN_ONLY: readonly UserRole[] = ["admin"];

/** Who may approve or reject a review item. */
export function canResolveReview(
  role: UserRole,
  item: { scope: ReviewScope; kind: ReviewKind },
): boolean {
  if (role === "admin") return true;
  return item.scope === "line";
}

export function requireRole(roles: readonly UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const { role } = currentUser(res);
    if (!roles.includes(role)) return next(errors.forbidden("Your role cannot do this"));
    next();
  };
}
