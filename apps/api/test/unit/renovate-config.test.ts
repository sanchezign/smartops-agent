import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Renovate rules that protect pinned decisions (phase 11, ADR-022; tightened in phase 13):
 * majors of the pinned packages are never proposed, and vitest + @vitest/coverage-v8 always
 * travel in the same PR (they must share one exact version — coverage-thresholds.test.ts).
 */

type Rule = {
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
  enabled?: boolean;
  groupName?: string;
};
const config = JSON.parse(
  readFileSync(new URL("../../../../renovate.json", import.meta.url), "utf8"),
) as { packageRules: Rule[] };

describe("renovate.json", () => {
  it("never proposes majors of ESLint (eslint and @eslint/js), Prisma, Next or React", () => {
    const blocked = config.packageRules
      .filter((r) => r.enabled === false && r.matchUpdateTypes?.includes("major"))
      .flatMap((r) => r.matchPackageNames ?? []);
    for (const name of ["eslint", "@eslint/js", "prisma", "@prisma/client", "next", "react"]) {
      expect(blocked, name).toContain(name);
    }
  });

  it("groups vitest and @vitest/coverage-v8 for every update type (the LAST matching rule wins)", () => {
    const last = (name: string) =>
      [...config.packageRules]
        .reverse()
        .find((r) => r.groupName && r.matchPackageNames?.includes(name) && !r.matchUpdateTypes);
    expect(last("vitest")?.groupName).toBe("vitest");
    expect(last("@vitest/coverage-v8")?.groupName).toBe("vitest");
    // …and it comes after the generic non-major group, so it overrides it.
    const index = (g: string) => config.packageRules.findIndex((r) => r.groupName === g);
    expect(index("vitest")).toBeGreaterThan(index("non-major dependencies"));
  });
});
