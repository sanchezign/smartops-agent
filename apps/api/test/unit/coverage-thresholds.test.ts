import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Coverage ratchet guard (phase 10, user rule): thresholds only go UP. Compared with HEAD
 * (uncommitted edits) and with origin/main (a branch cannot lower what main has).
 * Also: vitest and @vitest/coverage-v8 pinned to the SAME exact version in both apps.
 */

const FILES = ["apps/api/coverage-thresholds.json", "apps/admin/coverage-thresholds.json"];
const repoRoot = new URL("../../../../", import.meta.url);

type Thresholds = {
  global: Record<string, number>;
  files?: Record<string, Record<string, number>>;
};

function flatten(t: Thresholds): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(t.global)) out.set(`global.${k}`, v);
  for (const [file, metrics] of Object.entries(t.files ?? {}))
    for (const [k, v] of Object.entries(metrics)) out.set(`${file}.${k}`, v);
  return out;
}

function atRef(ref: string, path: string): Thresholds | null {
  try {
    const text = execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text) as Thresholds;
  } catch {
    return null; // not committed there yet / not a git checkout
  }
}

describe.each(FILES)("%s", (path) => {
  const current = JSON.parse(readFileSync(new URL(path, repoRoot), "utf8")) as Thresholds;

  it("every threshold is a percentage", () => {
    for (const [key, value] of flatten(current)) {
      expect(value, key).toBeGreaterThanOrEqual(0);
      expect(value, key).toBeLessThanOrEqual(100);
    }
  });

  it.each(["HEAD", "origin/main"])("no threshold is lower than in %s (ratchet)", (ref) => {
    const before = atRef(ref, path);
    if (!before) {
      // Locally (a fresh file, no remote yet) there may be nothing to compare with. In CI a
      // missing ref means a shallow checkout: fail loudly instead of silently passing
      // (phase 11; the workflow uses fetch-depth: 0). A thresholds file that is simply new
      // on this branch (origin/main exists, the file does not) is accepted.
      if (process.env.CI && ref === "origin/main" && atRef("origin/main", "package.json") === null)
        throw new Error("origin/main is not available — the CI checkout needs fetch-depth: 0");
      return;
    }
    const now = flatten(current);
    for (const [key, value] of flatten(before)) {
      expect(now.has(key), `${key} was removed`).toBe(true);
      expect(now.get(key)!, `${key} went down`).toBeGreaterThanOrEqual(value);
    }
  });
});

it("vitest and @vitest/coverage-v8 share the same EXACT version in both apps", () => {
  for (const app of ["apps/api", "apps/admin"]) {
    const pkg = JSON.parse(readFileSync(new URL(`${app}/package.json`, repoRoot), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const vitest = pkg.devDependencies.vitest!;
    expect(vitest, app).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["@vitest/coverage-v8"], app).toBe(vitest);
  }
});
