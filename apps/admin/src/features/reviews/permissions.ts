import type { SessionUser } from "@/lib/api-client";
import type { ReviewItem } from "./types";

/**
 * Mirror of the API rule (apps/api/src/modules/auth/permissions.ts, user decision phase 8,
 * amended by ADR-030): an operator resolves product lines only; whole lists (run gates) and
 * catalog-wide changes need an admin — except that in the public demo (DEMO_MODE, known from
 * GET /demo/info) an operator also resolves the column-mapping review. The API enforces it; the
 * panel only avoids offering buttons that answer 403.
 */
export function canResolve(
  user: SessionUser | null,
  item: Pick<ReviewItem, "scope" | "kind">,
  options: { demoMode?: boolean } = {},
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (item.scope === "line") return true;
  return options.demoMode === true && item.scope === "run" && item.kind === "column_mapping";
}
