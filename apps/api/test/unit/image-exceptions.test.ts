import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Accepted OS-package findings of the Docker images (Trivy): one list with the reasons
 * (security/audit-exceptions.json, "imageExceptions", next to the pnpm audit ones) and the file Trivy reads
 * (.trivyignore). They must say the same thing, and both workflows must really pass the file to Trivy.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf8");

interface ImageException {
  cve: string;
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
      expect(e.cve).toMatch(/^CVE-\d{4}-\d{4,}$/);
      expect(e.package).not.toBe("");
      expect(e.reason.length).toBeGreaterThanOrEqual(40);
      expect(e.removeWhen.length).toBeGreaterThanOrEqual(20);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.expires >= e.addedAt).toBe(true);
    }
  });

  it(".trivyignore holds exactly the listed CVEs with the same expiry, nothing else", () => {
    expect(ignoreLines.sort()).toEqual(list.map((e) => `${e.cve} exp:${e.expires}`).sort());
  });

  it("CVE-2026-103111 is the only one accepted today, and its reason cites the Debian tracker", () => {
    expect(list.map((e) => e.cve)).toEqual(["CVE-2026-103111"]);
    expect(list[0]!.reason).toContain("security-tracker.debian.org/tracker/CVE-2026-103111");
    expect(read(".trivyignore")).toContain("security-tracker.debian.org/tracker/CVE-2026-103111");
  });

  for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    it(`${file} mounts the file into the Trivy container and passes --ignorefile`, () => {
      const text = read(file);
      expect(text).toContain('-v "$PWD/.trivyignore:/.trivyignore:ro"');
      expect(text).toContain("--ignorefile /.trivyignore");
      expect(text).toContain("--show-suppressed"); // the log shows what was ignored
    });
  }

  it("CI scans BOTH images and fails at the end, not at the first failure", () => {
    const ci = read(".github/workflows/ci.yml");
    const step = ci.slice(ci.indexOf("OS-package vulnerabilities (Trivy"));
    expect(step).toContain("failed=0");
    expect(step).toContain("|| failed=1");
    expect(step).toContain('exit "$failed"');
    expect(step).toContain("smartops-api:ci smartops-admin:ci");
  });
});
