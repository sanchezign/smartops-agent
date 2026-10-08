import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope, UserRole } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";

/**
 * Phase 10 M2 (+ ADR-030, phase 14): the panel hides the approve / reject buttons with its own
 * copy of the rule (apps/admin/src/features/reviews/permissions.ts). If the two drift, an operator
 * either sees buttons that answer 403 or misses buttons it may use. Compared for EVERY role ×
 * scope × kind × mode (DEMO_MODE off / on). The panel file is loaded at runtime (its "@/…" imports
 * are type-only, erased by the loader), so the API typecheck never has to resolve the panel's
 * path aliases.
 */
type PanelCanResolve = (
  user: { role: string } | null,
  item: { scope: string; kind: string },
  options?: { demoMode?: boolean },
) => boolean;
const PANEL = new URL("../../../admin/src/features/reviews/permissions.ts", import.meta.url).href;

describe("review permissions: panel mirror = API rule", () => {
  it("agree for every role, scope, kind and mode (and nobody without a session)", async () => {
    const { canResolve } = (await import(/* @vite-ignore */ PANEL)) as {
      canResolve: PanelCanResolve;
    };
    let checked = 0;
    for (const demoMode of [false, true])
      for (const role of Object.values(UserRole))
        for (const scope of Object.values(ReviewScope))
          for (const kind of Object.values(ReviewKind)) {
            expect(
              canResolve({ role }, { scope, kind }, { demoMode }),
              `${role} ${scope}/${kind} demo=${demoMode}`,
            ).toBe(canResolveReview(role, { scope, kind }, { demoMode }));
            checked += 1;
          }
    expect(checked).toBe(
      2 *
        Object.keys(UserRole).length *
        Object.keys(ReviewScope).length *
        Object.keys(ReviewKind).length,
    );
    // the option omitted = DEMO_MODE off, in both implementations
    expect(canResolve({ role: "operator" }, { scope: "run", kind: "column_mapping" })).toBe(false);
    expect(canResolve(null, { scope: "line", kind: "product_match" })).toBe(false);
    expect(canResolve(null, { scope: "run", kind: "column_mapping" }, { demoMode: true })).toBe(
      false,
    );
  });
});
