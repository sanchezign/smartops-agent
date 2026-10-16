import type { SessionUser } from "@/lib/api-client";
import type { ReviewItem } from "./types";

/**
 * Mirror of the API rule (apps/api/src/modules/auth/permissions.ts, user decision phase 8,
 * amended by ADR-030 and ADR-034): an operator resolves product lines only; whole lists (run
 * gates) and catalog-wide changes need an admin — except in the public demo (DEMO_MODE, known from
 * GET /demo/info), where an operator resolves every review. The API enforces it; the panel only
 * avoids offering buttons that answer 403. A sync test compares both for every combination.
 */
export function canResolve(
  user: SessionUser | null,
  item: Pick<ReviewItem, "scope" | "kind">,
  options: { demoMode?: boolean } = {},
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (item.scope === "line") return true;
  return options.demoMode === true;
}

/**
 * ADR-034: a review the public demo lets an operator resolve, but that in a real installation
 * only an administrator resolves — the panel says so next to it. The same mirror, evaluated as
 * the real system (DEMO_MODE off).
 */
export function adminOnlyOutsideDemo(
  user: SessionUser | null,
  item: Pick<ReviewItem, "scope" | "kind">,
  options: { demoMode?: boolean } = {},
): boolean {
  return (
    options.demoMode === true &&
    user?.role !== "admin" &&
    canResolve(user, item, { demoMode: true }) &&
    !canResolve(user, item, { demoMode: false })
  );
}
