import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateTrivyReport, trivyGatePasses } from "../../scripts/security/trivy-gate.js";

/** Trivy gate of the nightly scan (ADR-028): fail closed, only HIGH/CRITICAL left after the ignorefile. */

const SCRIPT = fileURLToPath(new URL("../../scripts/security/trivy-gate.ts", import.meta.url));

const osResult = (vulns?: object[]) => ({
  Target: "ghcr.io/o/smartops-api:0.16.1 (debian 12.15)",
  Class: "os-pkgs",
  Type: "debian",
  ...(vulns ? { Vulnerabilities: vulns } : {}),
});
const libResult = (vulns: object[]) => ({
  Target: "Node.js",
  Class: "lang-pkgs",
  Type: "node-pkg",
  Vulnerabilities: vulns,
});
const vuln = (id: string, severity: string, pkg = "p") => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: "1.0.0",
  FixedVersion: "1.0.1",
  Severity: severity,
  Title: "t",
});
const report = (results: object[] | undefined) => ({
  SchemaVersion: 2,
  ArtifactName: "ghcr.io/o/smartops-api:0.16.1",
  ...(results ? { Results: results } : {}),
});

describe("evaluateTrivyReport", () => {
  it("a clean image (OS target without vulnerabilities) has no findings and no error", () => {
    const v = evaluateTrivyReport(report([osResult()]));
    expect(v.error).toBeNull();
    expect(v.findings).toEqual([]);
    expect(trivyGatePasses([v])).toBe(true);
  });

  it("OS and library HIGH/CRITICAL findings are findings; lower severities are not", () => {
    const v = evaluateTrivyReport(
      report([
        osResult([vuln("CVE-2026-1", "CRITICAL", "perl-base"), vuln("CVE-2026-2", "LOW")]),
        libResult([vuln("CVE-2026-3", "HIGH", "postcss"), vuln("CVE-2026-4", "MEDIUM")]),
      ]),
    );
    expect(v.findings.map((f) => f.id)).toEqual(["CVE-2026-1", "CVE-2026-3"]);
    expect(trivyGatePasses([v])).toBe(false);
  });

  it("fails closed on anything that is not a real report", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { SchemaVersion: 2 },
      { SchemaVersion: 2, ArtifactName: "i" }, // no Results
      report([]), // no OS target: nothing was really scanned
      report([libResult([])]),
    ]) {
      const v = evaluateTrivyReport(bad);
      expect(v.error, JSON.stringify(bad)).not.toBeNull();
      expect(trivyGatePasses([v])).toBe(false);
    }
  });

  it("the gate needs at least one verdict, and every one must be clean", () => {
    expect(trivyGatePasses([])).toBe(false);
    const clean = evaluateTrivyReport(report([osResult()]));
    const dirty = evaluateTrivyReport(report([osResult([vuln("CVE-2026-1", "HIGH")])]));
    expect(trivyGatePasses([clean, clean])).toBe(true);
    expect(trivyGatePasses([clean, dirty])).toBe(false);
  });
});

describe("trivy-gate.ts (the CLI the workflow runs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "trivy-gate-"));
  const write = (name: string, body: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const run = (...files: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8" });

  it("exits 0 for clean reports and 1 for findings, a missing file or garbage", () => {
    const clean = write("clean.json", report([osResult()]));
    const dirty = write("dirty.json", report([osResult([vuln("CVE-2026-1", "HIGH")])]));
    expect(run(clean).status).toBe(0);
    expect(run(clean, dirty).status).toBe(1);
    expect(run(join(dir, "missing.json")).status).toBe(1);
    expect(run(write("garbage.json", "not json")).status).toBe(1);
    expect(run().status).toBe(1);
  });

  it("prints findings as annotations and neutralizes workflow-command injection in third-party text", () => {
    const evil = { ...vuln("CVE-2026-1", "HIGH"), Title: "x\n::error::forged%0A" };
    const dirty = write("evil.json", report([osResult([evil])]));
    const result = run(dirty);
    expect(result.stdout).toContain("::error::HIGH CVE-2026-1");
    expect(result.stdout.split("\n").filter((l) => l.startsWith("::error::forged"))).toEqual([]);
  });
});
