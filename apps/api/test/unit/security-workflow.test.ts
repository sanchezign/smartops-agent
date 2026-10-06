import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nightly security scan (ADR-028): the workflow keeps its promises — daily, read-only, strict audit,
 * the published images scanned with the ignore file, fail closed, and the cron strings that the jobs'
 * `if:` conditions compare with are the ones declared under `schedule:`.
 */
const text = readFileSync(
  fileURLToPath(new URL("../../../../.github/workflows/security.yml", import.meta.url)),
  "utf8",
);
const job = (name: string) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
};

describe("security.yml", () => {
  const crons = [...text.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);

  it("has a weekly and a daily schedule, and each job's condition names one of them", () => {
    expect(crons).toHaveLength(2);
    expect(job("security")).toContain(`github.event.schedule == '${crons[0]}'`);
    expect(job("nightly-scan")).toContain(`github.event.schedule == '${crons[1]}'`);
    expect(crons[0]).toMatch(/\* \* 1$/); // Mondays
    expect(crons[1]).toMatch(/^\d+ \d+ \* \* \*$/); // every day
    expect(text).toContain("workflow_dispatch:");
  });

  it("never gets more than read access: no write permission anywhere, nothing at the top level", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).not.toMatch(/: write\b/);
    expect(job("nightly-scan")).toContain("packages: read");
    expect(job("security")).not.toContain("packages:");
  });

  it("the nightly scan runs the STRICT audit (no --base) and gates the Trivy reports", () => {
    const nightly = job("nightly-scan");
    expect(nightly).toMatch(/run: node apps\/api\/scripts\/security\/audit-gate\.ts\n/);
    expect(nightly).not.toContain("--base");
    expect(nightly).toContain("scripts/security/trivy-gate.ts");
  });

  it("scans the published images of the latest release, OS and libraries, with the ignore file", () => {
    const nightly = job("nightly-scan");
    expect(nightly).toContain("gh release view");
    expect(nightly).toContain("smartops-${app}:${VERSION}");
    expect(nightly).toContain("for app in api admin");
    expect(nightly).toContain("--ignorefile /.trivyignore");
    expect(nightly).toContain("--scanners vuln");
    expect(nightly).not.toContain("--pkg-types"); // OS packages AND libraries
    expect(nightly).toContain("--ignore-unfixed");
    expect(nightly).toContain("--severity HIGH,CRITICAL");
  });

  it("fails closed: set -e around Trivy, its status only means 'could not scan', findings go to the gate", () => {
    const nightly = job("nightly-scan");
    expect(nightly).toContain("set -euo pipefail");
    expect(nightly).toContain("--exit-code 0");
    expect(nightly).toContain("--format json");
  });

  it("keeps the secrets out of command lines and scripts (values come through env:)", () => {
    expect(text).not.toMatch(/run: .*\$\{\{/);
    expect(job("nightly-scan")).toContain("TRIVY_PASSWORD: ${{ github.token }}");
    expect(job("nightly-scan")).toContain("-e TRIVY_USERNAME -e TRIVY_PASSWORD");
  });

  it("keeps the weekly full-history gitleaks scan", () => {
    expect(job("security")).toContain("gitleaks");
    expect(job("security")).toContain("fetch-depth: 0");
  });
});
