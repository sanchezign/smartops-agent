/**
 * Dependency audit gate (phase 11 M3, user rule): `pnpm audit --prod` findings of severity
 * HIGH or CRITICAL block the build, unless they are listed in security/audit-exceptions.json
 * with a justification and an expiry date. An expired exception blocks again. Moderate/low
 * findings are only reported (Renovate + Dependabot alerts handle them).
 *
 *   node apps/api/scripts/security/audit-gate.ts        (CI: quick job + weekly security run)
 *
 * Builtins only, so Node runs it directly (native TypeScript) without installing anything.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AuditAdvisory {
  github_advisory_id: string;
  module_name: string;
  severity: string;
  title: string;
  patched_versions: string;
  findings: { version: string; paths: string[] }[];
}

export interface AuditException {
  advisory: string;
  package: string;
  reason: string;
  /** YYYY-MM-DD — the exception stops applying the day after. */
  expires: string;
  addedAt: string;
}

export interface GateResult {
  blocking: AuditAdvisory[];
  accepted: { advisory: AuditAdvisory; exception: AuditException }[];
  expired: { advisory: AuditAdvisory; exception: AuditException }[];
  reported: AuditAdvisory[];
  /** Exceptions that match nothing any more: remove them. */
  stale: AuditException[];
  /** Malformed exceptions (missing reason, bad date…): always blocking. */
  invalid: { exception: AuditException; problem: string }[];
}

const BLOCKING = new Set(["high", "critical"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateException(e: AuditException): string | null {
  if (!/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(e.advisory ?? ""))
    return "advisory must be a GHSA id";
  if (!e.package) return "package is required";
  if (!e.reason || e.reason.trim().length < 20) return "reason must explain why (≥ 20 characters)";
  if (!DATE.test(e.expires ?? "") || Number.isNaN(Date.parse(e.expires)))
    return "expires must be YYYY-MM-DD";
  if (!DATE.test(e.addedAt ?? "") || Number.isNaN(Date.parse(e.addedAt)))
    return "addedAt must be YYYY-MM-DD";
  if (e.expires < e.addedAt) return "expires is before addedAt";
  return null;
}

export function evaluateAudit(
  advisories: AuditAdvisory[],
  exceptions: AuditException[],
  today: string,
): GateResult {
  const result: GateResult = {
    blocking: [],
    accepted: [],
    expired: [],
    reported: [],
    stale: [],
    invalid: [],
  };
  const valid: AuditException[] = [];
  for (const exception of exceptions) {
    const problem = validateException(exception);
    if (problem) result.invalid.push({ exception, problem });
    else valid.push(exception);
  }
  const used = new Set<AuditException>();
  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) {
      result.reported.push(advisory);
      continue;
    }
    const exception = valid.find(
      (e) => e.advisory === advisory.github_advisory_id && e.package === advisory.module_name,
    );
    if (!exception) {
      result.blocking.push(advisory);
      continue;
    }
    used.add(exception);
    if (exception.expires < today) result.expired.push({ advisory, exception });
    else result.accepted.push({ advisory, exception });
  }
  result.stale = valid.filter((e) => !used.has(e));
  return result;
}

export function gatePasses(r: GateResult): boolean {
  return r.blocking.length === 0 && r.expired.length === 0 && r.invalid.length === 0;
}

const out = (text: string) =>
  process.stdout.write(`${text}
`);

function main(): void {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const exceptions = JSON.parse(
    readFileSync(new URL("../../../../security/audit-exceptions.json", import.meta.url), "utf8"),
  ) as { exceptions: AuditException[] };
  let raw: string;
  try {
    raw = execFileSync("pnpm", ["audit", "--prod", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (err) {
    // pnpm audit exits non-zero when it finds anything; the JSON is still on stdout.
    raw = (err as { stdout?: string }).stdout ?? "";
    if (!raw.trim()) throw err;
  }
  const report = JSON.parse(raw) as { advisories?: Record<string, AuditAdvisory> };
  const today = new Date().toISOString().slice(0, 10);
  const r = evaluateAudit(Object.values(report.advisories ?? {}), exceptions.exceptions, today);

  const line = (a: AuditAdvisory) =>
    `${a.severity.toUpperCase()} ${a.github_advisory_id} ${a.module_name} ${a.findings.map((f) => f.version).join(",")} (fix: ${a.patched_versions}) — ${a.title}`;
  for (const a of r.blocking) out(`::error::BLOCKING ${line(a)}`);
  for (const { advisory, exception } of r.expired)
    out(`::error::EXPIRED EXCEPTION (${exception.expires}) ${line(advisory)}`);
  for (const { exception, problem } of r.invalid)
    out(`::error::INVALID EXCEPTION ${exception.advisory ?? "?"}: ${problem}`);
  for (const { advisory, exception } of r.accepted)
    out(`accepted until ${exception.expires}: ${line(advisory)}`);
  for (const e of r.stale)
    out(`::warning::Stale exception (matches nothing now, remove it): ${e.advisory} ${e.package}`);
  out(`reported (moderate/low, not blocking): ${r.reported.length}`);
  if (!gatePasses(r)) process.exit(1);
  out("audit gate: OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
