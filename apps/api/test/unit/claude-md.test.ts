import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard for the project memory (user request after the phase 6 M3 commit truncated
 * CLAUDE.md, 2026-09-26). Fails if CLAUDE.md loses a key section, if a section is left
 * nearly empty, if the phase history has gaps, or if the file shrinks abruptly.
 * Growing the file is fine; after big intentional edits run `pnpm claude-md:baseline`
 * (it only moves the floor UP).
 */

const ROOT = new URL("../../../../", import.meta.url);
const text = readFileSync(new URL("CLAUDE.md", ROOT), "utf8");
const lines = text.split(/\r?\n/);
const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/claude-md-baseline.json", import.meta.url), "utf8"),
) as { lines: number; minPhases: number };

/** Key sections, in order (heading prefix). */
const REQUIRED = [
  "## Project",
  "## Cost constraint",
  "## Tests",
  "## Architecture (decided",
  "## Phase order",
  "## Stack deviations",
  "## Architecture decisions",
  "## Current phase",
  "## Known issues",
  "## Conventions in this project",
];

function section(prefix: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(prefix));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}
const bullets = (body: string[]) => body.filter((l) => /^- /.test(l)).length;

describe("CLAUDE.md guard", () => {
  it("has every key section, in order", () => {
    const positions = REQUIRED.map((h) => lines.findIndex((l) => l.startsWith(h)));
    REQUIRED.forEach((h, i) =>
      expect(positions[i], `missing section "${h}"`).toBeGreaterThanOrEqual(0),
    );
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("key sections are not left nearly empty", () => {
    expect(bullets(section("## Known issues"))).toBeGreaterThanOrEqual(10);
    expect(bullets(section("## Conventions in this project"))).toBeGreaterThanOrEqual(8);
    expect(bullets(section("## Architecture decisions"))).toBeGreaterThanOrEqual(30);
    expect(section("## Cost constraint").join("\n")).toMatch(/\$0/);
    expect(section("## Phase order").join("\n")).toMatch(/^1\. scaffold/m);
  });

  it("Current phase keeps the whole phase history (1..N without gaps)", () => {
    const numbers = section("## Current phase")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    const unique = [...new Set(numbers)];
    expect(unique.length).toBeGreaterThanOrEqual(baseline.minPhases);
    expect(unique).toEqual(unique.map((_, i) => i + 1));
  });

  it("does not shrink abruptly (versioned floor: 90 % of the baseline)", () => {
    expect(lines.length).toBeGreaterThanOrEqual(Math.floor(baseline.lines * 0.9));
  });

  // Local safety net before committing: compare with the committed version. In CI the
  // working copy IS the commit, so there is nothing to compare.
  it.skipIf(Boolean(process.env.CI))("uncommitted edits do not drop more than 15 % of HEAD", () => {
    let head: string;
    try {
      head = execFileSync("git", ["show", "HEAD:CLAUDE.md"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // not a git checkout
    }
    const headLines = head.split(/\r?\n/).length;
    expect(lines.length).toBeGreaterThanOrEqual(Math.floor(headLines * 0.85));
  });
});
