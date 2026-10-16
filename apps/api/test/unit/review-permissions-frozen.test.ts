import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope, UserRole } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";

/**
 * Phase 16 M2 (ADR-034), committed BEFORE the rule changed: the review permission table with
 * DEMO_MODE OFF, frozen as data (test/fixtures/review-permissions-demo-off.json) from the code of
 * phase 15. The demo extension must not change a single cell of it — this test compares the WHOLE
 * table (every role × scope × kind) with the option omitted, `{}` and `{ demoMode: false }`.
 *
 * There is deliberately no "record" switch: the fixture is never regenerated. If a future change
 * of the REAL system's permissions is wanted, it gets its own ADR and edits this file by hand.
 */
const FROZEN = JSON.parse(
  readFileSync(new URL("../fixtures/review-permissions-demo-off.json", import.meta.url), "utf8"),
) as { demoModeOff: Record<string, Record<string, boolean>> };

const ROLES = Object.values(UserRole);
const CELLS = Object.values(ReviewScope).flatMap((scope) =>
  Object.values(ReviewKind).map((kind) => ({ scope, kind, key: `${scope}/${kind}` })),
);

describe("review permissions with DEMO_MODE off = the frozen table (phase 16 M2)", () => {
  it("the fixture covers every role × scope × kind (no enum value added without a decision)", () => {
    expect(Object.keys(FROZEN.demoModeOff).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES)
      expect(Object.keys(FROZEN.demoModeOff[role]!).sort()).toEqual(CELLS.map((c) => c.key).sort());
  });

  it("canResolveReview answers exactly the frozen table, however DEMO_MODE off is spelled", () => {
    let checked = 0;
    for (const role of ROLES)
      for (const { scope, kind, key } of CELLS) {
        const frozen = FROZEN.demoModeOff[role]![key];
        expect(canResolveReview(role, { scope, kind }), `${role} ${key}`).toBe(frozen);
        expect(canResolveReview(role, { scope, kind }, {}), `${role} ${key} {}`).toBe(frozen);
        expect(
          canResolveReview(role, { scope, kind }, { demoMode: false }),
          `${role} ${key} demoMode:false`,
        ).toBe(frozen);
        checked += 1;
      }
    expect(checked).toBe(ROLES.length * CELLS.length);
  });

  it("the frozen table itself is the phase 8 rule: admin everything, operator product lines only", () => {
    for (const { scope, key } of CELLS) {
      expect(FROZEN.demoModeOff.admin![key], key).toBe(true);
      expect(FROZEN.demoModeOff.operator![key], key).toBe(scope === "line");
    }
  });
});
