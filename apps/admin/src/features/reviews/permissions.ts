import type { SessionUser } from "@/lib/api-client";
import type { ReviewItem } from "./types";

/**
 * Mirror of the API rule (apps/api/src/modules/auth/permissions.ts, user decision phase 8):
 * an operator resolves product lines only; whole lists (run gates) and catalog-wide changes
 * need an admin. The API enforces it; the panel only avoids offering buttons that answer 403.
 */
export function canResolve(user: SessionUser | null, item: Pick<ReviewItem, "scope">): boolean {
  if (!user) return false;
  return user.role === "admin" || item.scope === "line";
}
