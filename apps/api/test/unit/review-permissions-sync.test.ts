import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope, UserRole } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";

/**
 * Phase 10 M2: the panel hides the approve / reject buttons with its own copy of the rule
 * (apps/admin/src/features/reviews/permissions.ts). If the two drift, an operator either sees
 * buttons that answer 403 or misses buttons it may use. Compared for EVERY role × scope × kind.
 * The panel file is loaded at runtime (its "@/…" imports are type-only, erased by the loader),
 * so the API typecheck never has to resolve the panel's path aliases.
 */
type PanelCanResolve = (user: { role: string } | null, item: { scope: string }) => boolean;
const PANEL = new URL("../../../admin/src/features/reviews/permissions.ts", import.meta.url).href;

describe("review permissions: panel mirror = API rule", () => {
  it("agree for every role, scope and kind (and nobody without a session)", async () => {
    const { canResolve } = (await import(/* @vite-ignore */ PANEL)) as {
      canResolve: PanelCanResolve;
    };
    let checked = 0;
    for (const role of Object.values(UserRole))
      for (const scope of Object.values(ReviewScope))
        for (const kind of Object.values(ReviewKind)) {
          expect(canResolve({ role }, { scope }), `${role} ${scope} ${kind}`).toBe(
            canResolveReview(role, { scope, kind }),
          );
          checked += 1;
        }
    expect(checked).toBe(
      Object.keys(UserRole).length *
        Object.keys(ReviewScope).length *
        Object.keys(ReviewKind).length,
    );
    expect(canResolve(null, { scope: "line" })).toBe(false);
  });
});
