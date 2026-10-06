/**
 * Trivy gate of the nightly scan (ADR-028): reads the JSON reports Trivy wrote for the published
 * images and fails when any HIGH/CRITICAL finding is left after `.trivyignore` (the accepted ones,
 * with expiry, were already filtered out by Trivy itself).
 *
 *   node apps/api/scripts/security/trivy-gate.ts <report.json>...
 *
 * FAIL CLOSED: a missing, unreadable or malformed report, or one that proves no OS scan ran, is an
 * error — never "0 findings". Trivy runs with `--exit-code 0` so that its own exit status only
 * means "the scan itself failed" (pull denied, database download failed…).
 *
 * Builtins only, so Node runs it directly (native TypeScript) without installing anything.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface TrivyFinding {
  target: string;
  pkg: string;
  installed: string;
  id: string;
  severity: string;
  fixedIn: string;
  title: string;
}

export interface TrivyVerdict {
  /** Set when the report cannot be trusted: the gate fails. */
  error: string | null;
  artifact: string;
  findings: TrivyFinding[];
}

const BLOCKING = new Set(["HIGH", "CRITICAL"]);

/** Pure: a parsed Trivy JSON report in, the verdict out. */
export function evaluateTrivyReport(report: unknown): TrivyVerdict {
  const fail = (error: string, artifact = "?"): TrivyVerdict => ({ error, artifact, findings: [] });
  if (typeof report !== "object" || report === null) return fail("the report is not a JSON object");
  const r = report as {
    SchemaVersion?: unknown;
    ArtifactName?: unknown;
    Results?: unknown;
  };
  if (typeof r.SchemaVersion !== "number") return fail("no SchemaVersion: not a Trivy report");
  if (typeof r.ArtifactName !== "string" || r.ArtifactName === "")
    return fail("no ArtifactName: not a Trivy report");
  const artifact = r.ArtifactName;
  if (!Array.isArray(r.Results)) return fail("no Results: the scan did not run", artifact);
  type RawResult = {
    Target?: string;
    Class?: string;
    Vulnerabilities?: {
      PkgName?: string;
      InstalledVersion?: string;
      VulnerabilityID?: string;
      Severity?: string;
      FixedVersion?: string;
      Title?: string;
    }[];
  };
  const results = r.Results as RawResult[];
  // A clean image still reports its OS target (with no Vulnerabilities): no OS target = no OS scan.
  if (!results.some((x) => x.Class === "os-pkgs"))
    return fail("no OS packages target in the report: the image was not really scanned", artifact);
  const findings: TrivyFinding[] = [];
  for (const res of results) {
    for (const v of res.Vulnerabilities ?? []) {
      if (!BLOCKING.has(String(v.Severity).toUpperCase())) continue;
      findings.push({
        target: res.Target ?? "?",
        pkg: v.PkgName ?? "?",
        installed: v.InstalledVersion ?? "?",
        id: v.VulnerabilityID ?? "?",
        severity: String(v.Severity).toUpperCase(),
        fixedIn: v.FixedVersion ?? "",
        title: (v.Title ?? "").slice(0, 120),
      });
    }
  }
  return { error: null, artifact, findings };
}

export function trivyGatePasses(verdicts: TrivyVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v.error === null && v.findings.length === 0);
}

const out = (text: string) => process.stdout.write(`${text}\n`);
/** Third-party text goes into workflow commands: strip anything that could start a new one. */
const clean = (text: string) => text.replace(/[\r\n%]/g, " ");

function main(files: string[]): void {
  if (files.length === 0) {
    out("::error::trivy-gate: no report files given");
    process.exit(1);
  }
  const verdicts: TrivyVerdict[] = files.map((file) => {
    try {
      return evaluateTrivyReport(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      return {
        error: `cannot read ${file}: ${(err as Error).message}`,
        artifact: file,
        findings: [],
      };
    }
  });
  for (const v of verdicts) {
    if (v.error) out(`::error::SCAN FAILED ${clean(v.artifact)}: ${clean(v.error)}`);
    for (const f of v.findings) {
      out(
        `::error::${f.severity} ${clean(f.id)} ${clean(f.pkg)} ${clean(f.installed)} (fix: ${clean(f.fixedIn) || "none"}) in ${clean(v.artifact)} [${clean(f.target)}] — ${clean(f.title)}`,
      );
    }
    if (!v.error && v.findings.length === 0) out(`clean: ${v.artifact}`);
  }
  if (!trivyGatePasses(verdicts)) process.exit(1);
  out("trivy gate: OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
