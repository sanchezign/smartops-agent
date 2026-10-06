import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exceptionWindowProblem } from "../../scripts/security/audit-gate.js";

/**
 * Accepted OS-package findings of the Docker images (Trivy): one list with the reasons
 * (security/audit-exceptions.json, "imageExceptions", next to the pnpm audit ones) and the file Trivy reads
 * (.trivyignore). They must say the same thing, and both workflows must really pass the file to Trivy.
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
const list = (
  JSON.parse(read("security/audit-exceptions.json")) as { imageExceptions: ImageException[] }
).imageExceptions;
const ignoreLines = read(".trivyignore")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"));

describe("image (Trivy) exceptions", () => {
  it("each one has a CVE id, a real reason, dates and a removal condition", () => {
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(e.cve).toMatch(/^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/);
      expect(e.package).not.toBe("");
      expect(e.reason.length).toBeGreaterThanOrEqual(40);
      expect(e.removeWhen.length).toBeGreaterThanOrEqual(20);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.expires >= e.addedAt).toBe(true);
    }
  });

  it("each one respects the maximum life: CRITICAL ≤ 7 days, HIGH ≤ 30 days from addedAt", () => {
    for (const e of list) {
      expect(exceptionWindowProblem(e.severity, e.addedAt, e.expires), e.cve).toBeNull();
    }
  });

  it(".trivyignore holds exactly the listed CVEs with the same expiry, nothing else", () => {
    expect(ignoreLines.sort()).toEqual(list.map((e) => `${e.cve} exp:${e.expires}`).sort());
  });

  it("the OS findings accepted today are the seven Perl CVEs, short-lived, each citing its Debian tracker", () => {
    const os = list.filter((e) => e.package === "perl-base");
    expect(os.map((e) => e.cve).sort()).toEqual(
      [
        "CVE-2026-13221",
        "CVE-2026-42496",
        "CVE-2026-8376",
        "CVE-2026-42497",
        "CVE-2026-48962",
        "CVE-2026-57432",
        "CVE-2026-57433",
      ].sort(),
    );
    for (const e of os) {
      expect(e.expires).toBe("2026-10-13");
      expect(e.reason).toContain(`security-tracker.debian.org/tracker/${e.cve}`);
    }
  });

  it("the library findings accepted for the nightly scan mirror the pnpm audit exceptions (same expiry)", () => {
    const audit = (
      JSON.parse(read("security/audit-exceptions.json")) as {
        exceptions: { package: string; expires: string }[];
      }
    ).exceptions;
    const library = list.filter((e) => e.package !== "perl-base");
    expect(library.map((e) => e.package).sort()).toEqual([
      "deepmerge-ts",
      "mysql2",
      "postcss",
      "postcss",
    ]);
    for (const e of library) {
      const twin = audit.find((a) => a.package === e.package);
      expect(twin, e.cve).toBeDefined();
      expect(e.expires).toBe(twin?.expires);
    }
  });

  for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    it(`${file} mounts the file into the Trivy container and passes --ignorefile`, () => {
      const text = read(file);
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
