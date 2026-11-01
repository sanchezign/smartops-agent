import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exceptionWindowProblem } from "../../scripts/security/audit-gate.js";

/**
 * Accepted OS-package findings of the Docker images (Trivy): one list with the reasons
 * (security/audit-exceptions.json, "imageExceptions", next to the pnpm audit ones) and the file Trivy reads
 * (.trivyignore). They must say the same thing, and both workflows must really pass the file to Trivy.
 * The list may be empty (no exceptions today): the rules are therefore also tested on examples below,
 * each with a case that passes and one that fails.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf8");

interface ImageException {
  cve: string;
  severity: string;
  package: string;
  reason: string;
  removeWhen: string;
  expires: string;
  addedAt: string;
}
interface AuditEntry {
  package: string;
  expires: string;
}

const ID = /^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What one image exception must look like (empty array = fine). */
function formatProblems(e: ImageException): string[] {
  const p: string[] = [];
  if (!ID.test(e.cve)) p.push("cve id");
  if (e.package === "") p.push("package");
  if (e.reason.length < 40) p.push("reason");
  if (e.removeWhen.length < 20) p.push("removeWhen");
  if (!DATE.test(e.expires)) p.push("expires format");
  if (!DATE.test(e.addedAt)) p.push("addedAt format");
  if (e.expires < e.addedAt) p.push("expires before addedAt");
  return p;
}

/** .trivyignore must hold exactly the listed CVEs with the same expiry (null = identical). */
function mirrorProblem(lines: string[], entries: ImageException[]): string | null {
  const got = [...lines].sort();
  const want = entries.map((e) => `${e.cve} exp:${e.expires}`).sort();
  return JSON.stringify(got) === JSON.stringify(want)
    ? null
    : `.trivyignore [${got.join(", ")}] != list [${want.join(", ")}]`;
}

/** Every library exception needs its twin in the pnpm audit exceptions: same package, same expiry. */
function twinProblems(entries: ImageException[], audit: AuditEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const twin = audit.find((a) => a.package === e.package);
    if (!twin) out.push(`${e.cve}: no pnpm audit twin for ${e.package}`);
    else if (twin.expires !== e.expires) out.push(`${e.cve}: expiry differs from its twin`);
  }
  return out;
}

const example = (over: Partial<ImageException> = {}): ImageException => ({
  cve: "CVE-2026-40345",
  severity: "high",
  package: "left-pad",
  reason: "HIGH: build-time only, our own input, never reachable from the product.",
  removeWhen: "The dependency is updated: delete this entry and its line.",
  expires: "2026-11-30",
  addedAt: "2026-11-01",
  ...over,
});

const file = JSON.parse(read("security/audit-exceptions.json")) as {
  exceptions: AuditEntry[];
  imageExceptions: ImageException[];
};
const list = file.imageExceptions;
const ignoreLines = read(".trivyignore")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"));

describe("image (Trivy) exception rules, on examples", () => {
  it("format: a complete entry passes; each defect is reported", () => {
    expect(formatProblems(example())).toEqual([]);
    expect(formatProblems(example({ cve: "nope" }))).toEqual(["cve id"]);
    expect(formatProblems(example({ package: "" }))).toEqual(["package"]);
    expect(formatProblems(example({ reason: "too short" }))).toEqual(["reason"]);
    expect(formatProblems(example({ removeWhen: "soon" }))).toEqual(["removeWhen"]);
    expect(formatProblems(example({ expires: "2026-13" }))).toEqual(["expires format"]);
    expect(formatProblems(example({ expires: "2026-10-01" }))).toEqual(["expires before addedAt"]);
  });

  it("life: HIGH ≤ 30 days and CRITICAL ≤ 7 days pass; one day more fails", () => {
    expect(exceptionWindowProblem("high", "2026-11-01", "2026-12-01")).toBeNull();
    expect(exceptionWindowProblem("high", "2026-11-01", "2026-12-02")).toMatch(/at most 30/);
    expect(exceptionWindowProblem("critical", "2026-11-01", "2026-11-08")).toBeNull();
    expect(exceptionWindowProblem("critical", "2026-11-01", "2026-11-09")).toMatch(/at most 7/);
    expect(exceptionWindowProblem("low", "2026-11-01", "2026-11-02")).toMatch(/severity/);
  });

  it(".trivyignore mirror: identical passes; a missing, extra or different-expiry line fails", () => {
    const entries = [example(), example({ cve: "GHSA-3f6p-5ww8-9rcr" })];
    const lines = ["CVE-2026-40345 exp:2026-11-30", "GHSA-3f6p-5ww8-9rcr exp:2026-11-30"];
    expect(mirrorProblem(lines, entries)).toBeNull();
    expect(mirrorProblem([], [])).toBeNull();
    expect(mirrorProblem(lines.slice(1), entries)).not.toBeNull();
    expect(mirrorProblem([...lines, "CVE-2026-99999 exp:2026-11-30"], entries)).not.toBeNull();
    expect(mirrorProblem(["CVE-2026-40345 exp:2026-11-29", lines[1] ?? ""], entries)).not.toBeNull();
  });

  it("twin: a library exception with its pnpm audit twin (same expiry) passes; none or another expiry fails", () => {
    const entries = [example()];
    expect(twinProblems(entries, [{ package: "left-pad", expires: "2026-11-30" }])).toEqual([]);
    expect(twinProblems([], [])).toEqual([]);
    expect(twinProblems(entries, [])).toHaveLength(1);
    expect(twinProblems(entries, [{ package: "left-pad", expires: "2026-11-29" }])).toHaveLength(1);
    expect(twinProblems(entries, [{ package: "other", expires: "2026-11-30" }])).toHaveLength(1);
  });
});

describe("image (Trivy) exceptions", () => {
  it("each one has a CVE id, a real reason, dates and a removal condition (none today is fine)", () => {
    for (const e of list) expect(formatProblems(e), e.cve).toEqual([]);
  });

  it("each one respects the maximum life: CRITICAL ≤ 7 days, HIGH ≤ 30 days from addedAt", () => {
    for (const e of list) {
      expect(exceptionWindowProblem(e.severity, e.addedAt, e.expires), e.cve).toBeNull();
    }
  });

  it(".trivyignore holds exactly the listed CVEs with the same expiry, nothing else", () => {
    expect(mirrorProblem(ignoreLines, list)).toBeNull();
  });

  it("no Perl exception is left: the node base image already brings perl-base >= deb12u4 (no workaround step)", () => {
    expect(list.filter((e) => e.package === "perl-base")).toEqual([]);
    for (const dockerfile of ["apps/api/Dockerfile", "apps/admin/Dockerfile"]) {
      expect(read(dockerfile), dockerfile).not.toContain("--only-upgrade perl-base");
    }
  });

  it("the library findings accepted for the nightly scan mirror the pnpm audit exceptions (same expiry)", () => {
    expect(twinProblems(list, file.exceptions)).toEqual([]);
  });

  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    it(`${workflow} mounts the file into the Trivy container and passes --ignorefile`, () => {
      const text = read(workflow);
      expect(text).toContain('-v "$PWD/.trivyignore:/.trivyignore:ro"');
      expect(text).toContain("--ignorefile /.trivyignore");
      expect(text).toContain("--show-suppressed"); // the log shows what was ignored
    });
  }

  it("CI scans BOTH images and, in a pull request, only WARNS at the end (ADR-028)", () => {
    const ci = read(".github/workflows/ci.yml");
    const step = ci.slice(ci.indexOf("OS-package vulnerabilities (Trivy"));
    expect(step).toContain("failed=0");
    expect(step).toContain("|| failed=1");
    expect(step).toContain("::warning title=Trivy::");
    expect(step).not.toContain('exit "$failed"');
    expect(step).toContain("smartops-api:ci smartops-admin:ci");
  });

  it("the release workflow still BLOCKS on the same findings", () => {
    const release = read(".github/workflows/release.yml");
    const step = release.slice(release.indexOf("OS-package vulnerabilities (Trivy"));
    expect(step).toContain("--exit-code 1");
    expect(step).toContain("--ignorefile /.trivyignore");
  });
});
