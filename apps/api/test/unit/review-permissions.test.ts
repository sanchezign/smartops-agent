import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope, UserRole } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";

/**
 * Who may resolve which review item, role × scope × kind × mode (ADR-030, phase 14 M4b).
 *
 * The rule of phase 8 is restated HERE, verbatim, as `phase8Rule`: it is the evidence that with
 * DEMO_MODE off nothing changed. The only permission added for the demo is
 * operator + scope "run" + kind "column_mapping".
 */
const phase8Rule = (role: string, item: { scope: string }) =>
  role === "admin" || item.scope === "line";

const ROLES = Object.values(UserRole);
const SCOPES = Object.values(ReviewScope);
const KINDS = Object.values(ReviewKind);
const combos = ROLES.flatMap((role) =>
  SCOPES.flatMap((scope) => KINDS.map((kind) => ({ role, scope, kind }))),
);

describe("canResolveReview: DEMO_MODE off is IDENTICAL to the phase 8 rule", () => {
  it(`all ${combos.length} role × scope × kind combinations, with the option omitted and with demoMode: false`, () => {
    expect(combos.length).toBe(ROLES.length * SCOPES.length * KINDS.length);
    for (const { role, scope, kind } of combos) {
      const expected = phase8Rule(role, { scope });
      expect(canResolveReview(role, { scope, kind }), `${role} ${scope}/${kind}`).toBe(expected);
      expect(canResolveReview(role, { scope, kind }, {}), `${role} ${scope}/${kind}`).toBe(
        expected,
      );
      expect(
        canResolveReview(role, { scope, kind }, { demoMode: false }),
        `${role} ${scope}/${kind}`,
      ).toBe(expected);
    }
  });
});

describe("canResolveReview: DEMO_MODE on differs in exactly ONE combination", () => {
  it("the only difference is operator + run + column_mapping", () => {
    const differing = combos
      .filter(
        ({ role, scope, kind }) =>
          canResolveReview(role, { scope, kind }, { demoMode: true }) !==
          canResolveReview(role, { scope, kind }, { demoMode: false }),
      )
      .map(({ role, scope, kind }) => `${role} ${scope}/${kind}`);
    expect(differing).toEqual(["operator run/column_mapping"]);
  });

  it("every other whole-list gate and catalog-wide change stays admin-only in the demo", () => {
    for (const kind of KINDS) {
      if (kind === "column_mapping") continue;
      expect(canResolveReview("operator", { scope: "run", kind }, { demoMode: true }), kind).toBe(
        false,
      );
      expect(
        canResolveReview("operator", { scope: "catalog", kind }, { demoMode: true }),
        kind,
      ).toBe(false);
    }
    // a column_mapping outside the "run" scope would not exist; it is not opened either
    expect(
      canResolveReview(
        "operator",
        { scope: "catalog", kind: "column_mapping" },
        { demoMode: true },
      ),
    ).toBe(false);
  });

  it("the admin and line reviews are unaffected by the mode", () => {
    for (const mode of [false, true]) {
      for (const scope of SCOPES)
        for (const kind of KINDS)
          expect(canResolveReview("admin", { scope, kind }, { demoMode: mode })).toBe(true);
      for (const kind of KINDS)
        expect(canResolveReview("operator", { scope: "line", kind }, { demoMode: mode })).toBe(
          true,
        );
    }
  });
});
