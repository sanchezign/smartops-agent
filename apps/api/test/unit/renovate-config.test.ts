import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Renovate rules that protect pinned decisions (phase 11, ADR-022; tightened in phase 13):
 * majors of the pinned packages are never proposed, and vitest + @vitest/coverage-v8 always
 * travel in the same PR (they must share one exact version — coverage-thresholds.test.ts).
 */

type Rule = {
  matchDatasources?: string[];
  matchPackageNames?: string[];
  schedule?: string[];
  automerge?: boolean;
  minimumReleaseAgeBehaviour?: string;
  matchUpdateTypes?: string[];
  enabled?: boolean;
  groupName?: string;
};
const config = JSON.parse(
  readFileSync(new URL("../../../../renovate.json", import.meta.url), "utf8"),
) as { packageRules: Rule[]; automerge?: boolean };

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

  it("reviews the node and postgres image digests DAILY, in their own PR (ADR-028)", () => {
    const rule = config.packageRules.find((r) => r.groupName === "base image digests");
    expect(rule?.matchDatasources).toEqual(["docker"]);
    expect(rule?.matchPackageNames?.sort()).toEqual(["node", "postgres"]);
    expect(rule?.matchUpdateTypes).toEqual(expect.arrayContaining(["digest", "pinDigest"]));
    // A schedule without a weekday: it runs every day (the generic one is "before 6am on monday").
    expect(rule?.schedule).toEqual(["before 6am"]);
    // Docker digests carry no release timestamp: without this the age check would hold them back for good.
    expect(rule?.minimumReleaseAgeBehaviour).toBe("timestamp-optional");
    // It comes after the generic non-major group, so its group name wins.
    const index = (g: string) => config.packageRules.findIndex((r) => r.groupName === g);
    expect(index("base image digests")).toBeGreaterThan(index("non-major dependencies"));
  });

  it("never automerges anything (the owner merges every dependency PR)", () => {
    expect(config.automerge).not.toBe(true);
    for (const rule of config.packageRules)
      expect(rule.automerge, JSON.stringify(rule)).not.toBe(true);
  });
});
