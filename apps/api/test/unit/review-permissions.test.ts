import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope, UserRole } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";

/**
 * Who may resolve which review item, role × scope × kind × mode (ADR-030, phase 14 M4b; ADR-034).
 *
 * The rule of phase 8 is restated HERE, verbatim, as `phase8Rule`: it is the evidence that with
 * DEMO_MODE off nothing changed (the frozen table of review-permissions-frozen.test.ts says the same
 * from data). In the demo (ADR-034, phase 16) the operator resolves every review.
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

describe("canResolveReview: DEMO_MODE on (ADR-034, phase 16)", () => {
  it("an operator resolves EVERY review in the demo: exactly the operator's non-line cells differ", () => {
    const differing = combos
      .filter(
        ({ role, scope, kind }) =>
          canResolveReview(role, { scope, kind }, { demoMode: true }) !==
          canResolveReview(role, { scope, kind }, { demoMode: false }),
      )
      .map(({ role, scope, kind }) => `${role} ${scope}/${kind}`);
    const expected = combos
      .filter(({ role, scope }) => role === "operator" && scope !== "line")
      .map(({ role, scope, kind }) => `${role} ${scope}/${kind}`);
    expect(differing).toEqual(expected);
    for (const scope of SCOPES)
      for (const kind of KINDS)
        expect(
          canResolveReview("operator", { scope, kind }, { demoMode: true }),
          `${scope}/${kind}`,
        ).toBe(true);
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

  it("only a strict boolean true opens it (a truthy string or number from a request never does)", () => {
    for (const bogus of ["true", 1, "1", "yes", {}] as unknown[])
      expect(
        canResolveReview(
          "operator",
          { scope: "run", kind: "suspicious_instructions" },
          {
            demoMode: bogus as boolean,
          },
        ),
        String(bogus),
      ).toBe(false);
  });
});
