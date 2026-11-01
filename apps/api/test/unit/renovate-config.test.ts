import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Renovate rules that protect pinned decisions (phase 11, ADR-022; tightened in phase 13):
 * majors of the pinned packages are never proposed, and vitest + @vitest/coverage-v8 always
 * travel in the same PR (they must share one exact version — coverage-thresholds.test.ts); only patch
 * updates are automerged (not the pinned packages, base images or lockFileMaintenance).
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
) as {
  packageRules: Rule[];
  automerge?: boolean;
  platformAutomerge?: boolean;
  automergeType?: string;
  automergeStrategy?: string;
  minimumReleaseAge?: string;
  lockFileMaintenance?: { automerge?: boolean };
};

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

  it("automerges ONLY patch updates, through GitHub's auto-merge, by rebase, after the age check", () => {
    expect(config.automerge).toBe(false);
    expect(config.platformAutomerge).toBe(true);
    expect(config.automergeType).toBe("pr");
    // rebase: the repo does not squash (it would break the release-please changelog)
    expect(config.automergeStrategy).toBe("rebase");
    expect(config.minimumReleaseAge).toBe("3 days");
    const merging = config.packageRules.filter((r) => r.automerge === true);
    expect(merging).toHaveLength(1);
    expect(merging[0]?.matchUpdateTypes).toEqual(["patch"]);
  });

  it("the automerge rule excludes the packages pinned on purpose", () => {
    const names = config.packageRules.find((r) => r.automerge === true)?.matchPackageNames ?? [];
    for (const name of [
      "prisma",
      "@prisma/client",
      "@prisma/adapter-pg",
      "next",
      "eslint-config-next",
      "react",
      "react-dom",
      "eslint",
      "@eslint/js",
    ]) {
      expect(names, name).toContain(`!${name}`);
    }
    // negations only: a "*" next to other patterns is rejected by the Renovate validator
    expect(names.every((n) => n.startsWith("!"))).toBe(true);
  });

  it("never automerges the node and postgres images (the owner merges) nor lockFileMaintenance", () => {
    const automergeIndex = config.packageRules.findIndex((r) => r.automerge === true);
    const images = config.packageRules.findIndex(
      (r) =>
        r.automerge === false &&
        !r.matchUpdateTypes &&
        r.matchDatasources?.includes("docker") &&
        r.matchPackageNames?.includes("node") &&
        r.matchPackageNames.includes("postgres"),
    );
    // it comes AFTER the automerge rule: the last matching rule wins
    expect(images).toBeGreaterThan(automergeIndex);
    expect(config.lockFileMaintenance?.automerge).toBe(false);
    // the daily base image digest rule keeps its explicit automerge: false
    expect(config.packageRules.find((r) => r.groupName === "base image digests")?.automerge).toBe(
      false,
    );
  });
});
