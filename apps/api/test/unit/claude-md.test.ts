import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard for the project memory (user request after the phase 6 M3 commit truncated
 * CLAUDE.md, 2026-09-26; reworked 2026-10-06 when CLAUDE.md was slimmed from ~206,000 to
 * under 45,000 characters and its history moved to docs/history/).
 *
 * Fails if CLAUDE.md loses a key section or grows past MAX_CHARS (the real problem: the file is
 * loaded in every session and was truncated at 150,000), if the ADR index misses an ADR, if
 * docs/history/phase-log.md loses phases (1..N without gaps), or if CLAUDE.md + docs/history
 * together shrink abruptly. After big intentional growth run `pnpm claude-md:baseline` (it only
 * moves the floors UP).
 */

const MAX_CHARS = 45_000;

const ROOT = new URL("../../../../", import.meta.url);
const text = readFileSync(new URL("CLAUDE.md", ROOT), "utf8");
const lines = text.split(/\r?\n/);
const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/claude-md-baseline.json", import.meta.url), "utf8"),
) as { lines: number; phaseLogLines: number; minPhases: number };

const HISTORY_DIR = new URL("docs/history/", ROOT);
const historyFiles = existsSync(HISTORY_DIR)
  ? readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
  : [];
const historyText = (name: string) => readFileSync(new URL(name, HISTORY_DIR), "utf8");
const lineCount = (s: string) => s.split(/\r?\n/).length;
/** Lines of CLAUDE.md + every docs/history/*.md in the working tree. */
const totalLines =
  lineCount(text) + historyFiles.reduce((n, f) => n + lineCount(historyText(f)), 0);

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
  "## History",
];

function section(prefix: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(prefix));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}
const bullets = (body: string[]) => body.filter((l) => /^- /.test(l)).length;

/** Lines of CLAUDE.md + docs/history/*.md at a git ref; null when CLAUDE.md is not there. */
function totalLinesAt(ref: string): number | null {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let total: number;
  try {
    total = lineCount(git("show", `${ref}:CLAUDE.md`));
  } catch {
    return null;
  }
  let names: string[] = [];
  try {
    names = git("ls-tree", "--name-only", ref, "docs/history/")
      .split("\n")
      .filter((n) => n.endsWith(".md"));
  } catch {
    // the ref has no docs/history yet (before the slimming): CLAUDE.md alone is the total
  }
  for (const name of names) total += lineCount(git("show", `${ref}:${name}`));
  return total;
}

describe("CLAUDE.md guard", () => {
  it(`stays under ${MAX_CHARS} characters (loaded in every session)`, () => {
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
  });

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
    expect(section("## Cost constraint").join("\n")).toMatch(/\$0/);
    expect(section("## Phase order").join("\n")).toMatch(/^1\. scaffold/m);
  });

  it("indexes every ADR in docs/adr/ with a link", () => {
    const adrs = readdirSync(new URL("docs/adr/", ROOT)).filter((f) => /^ADR-\d+.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThan(0);
    const body = section("## Architecture decisions").join("\n");
    for (const file of adrs) {
      expect(body, `ADR index is missing ${file}`).toContain(`(docs/adr/${file})`);
    }
  });

  it("links docs/history/ and every history file exists", () => {
    expect(text).toContain("docs/history/");
    for (const name of [
      "README.md",
      "phase-log.md",
      "phase-order-detail.md",
      "architecture-decisions.md",
      "resolved-issues.md",
    ]) {
      expect(historyFiles, `docs/history/${name} is missing`).toContain(name);
    }
  });

  it("Conventions keep the rule that closed detail moves to docs/history/phase-log.md", () => {
    const body = section("## Conventions in this project").join("\n");
    expect(body).toContain("docs/history/phase-log.md");
    expect(body).toMatch(/Current phase.*only holds what is active/s);
  });

  it("phase-log.md keeps the whole phase history (1..N without gaps)", () => {
    const log = historyText("phase-log.md");
    const numbers = log
      .split(/\r?\n/)
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    const unique = [...new Set(numbers)];
    expect(unique.length).toBeGreaterThanOrEqual(baseline.minPhases);
    expect(unique).toEqual(unique.map((_, i) => i + 1));
  });

  it("does not shrink abruptly (versioned floors: 90 % of the baseline)", () => {
    expect(lines.length).toBeGreaterThanOrEqual(Math.floor(baseline.lines * 0.9));
    expect(lineCount(historyText("phase-log.md"))).toBeGreaterThanOrEqual(
      Math.floor(baseline.phaseLogLines * 0.9),
    );
  });

  // Local safety net before committing: compare CLAUDE.md + docs/history with the committed
  // version. In CI the working copy IS the commit, so there is nothing to compare.
  it.skipIf(Boolean(process.env.CI))(
    "uncommitted edits do not drop more than 15 % of HEAD (CLAUDE.md + docs/history)",
    () => {
      const head = totalLinesAt("HEAD");
      if (head === null) return; // not a git checkout
      expect(totalLines).toBeGreaterThanOrEqual(Math.floor(head * 0.85));
    },
  );

  // CI counterpart (phase 11): compare with the base branch the change will land on. The
  // workflow checks out the full history (fetch-depth: 0); a missing base ref in CI is a
  // FAILURE, never a silent skip — otherwise this gate would pass without checking anything.
  // The total is CLAUDE.md + docs/history/*.md on both sides, so moving text into docs/history
  // is fine but deleting it is not.
  it.runIf(Boolean(process.env.CI))(
    "CLAUDE.md + docs/history do not drop more than 15 % of the base branch (CI)",
    () => {
      const base = `origin/${process.env.GITHUB_BASE_REF || "main"}`;
      const baseTotal = totalLinesAt(base);
      if (baseTotal === null) {
        throw new Error(`${base}:CLAUDE.md not found — the CI checkout needs fetch-depth: 0`);
      }
      expect(totalLines).toBeGreaterThanOrEqual(Math.floor(baseTotal * 0.85));
    },
  );
});
