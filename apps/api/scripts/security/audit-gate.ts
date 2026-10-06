/**
 * Dependency audit gate (phase 11 M3, user rule): `pnpm audit --prod` findings of severity
 * HIGH or CRITICAL block the build, unless they are listed in security/audit-exceptions.json
 * with a justification and an expiry date. An expired exception blocks again. Moderate/low
 * findings are only reported (Renovate + Dependabot alerts handle them).
 *
 *   node apps/api/scripts/security/audit-gate.ts                (strict: every finding counts —
 *                                                                the scheduled security run)
 *   node apps/api/scripts/security/audit-gate.ts --base auto    (diff: only findings the change
 *                                                                INTRODUCES block — the quick job)
 *
 * Diff mode (ADR-028): the same audit runs on the base (merge-base with origin/main, or the
 * previous tip of main on a push to main) and on the head. A finding already present in the base is
 * "pre-existing": reported as a warning, never blocking, so an advisory published today cannot turn
 * a docs-only pull request red. If the base cannot be resolved the gate falls back to strict.
 * Exceptions have a maximum life: CRITICAL ≤ 7 days from addedAt, HIGH ≤ 30 days.
 *
 * Builtins only, so Node runs it directly (native TypeScript) without installing anything.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Severity the exception was granted for; it sets the maximum life (see MAX_EXCEPTION_DAYS). */
  severity: "high" | "critical";
  /** YYYY-MM-DD — the exception stops applying the day after. */
  expires: string;
  addedAt: string;
}

/** Longest an exception may live, in days from addedAt (user rule, 2026-10-06, ADR-028). */
export const MAX_EXCEPTION_DAYS = { critical: 7, high: 30 } as const;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Shared by the pnpm audit exceptions and the image (Trivy) exceptions. */
export function exceptionWindowProblem(
  severity: string | undefined,
  addedAt: string,
  expires: string,
): string | null {
  if (severity !== "high" && severity !== "critical") return "severity must be high or critical";
  const max = MAX_EXCEPTION_DAYS[severity];
  const days = daysBetween(addedAt, expires);
  if (days > max) return `a ${severity} exception may last at most ${max} days (this one: ${days})`;
  return null;
}

export interface GateResult {
  blocking: AuditAdvisory[];
  accepted: { advisory: AuditAdvisory; exception: AuditException }[];
  expired: { advisory: AuditAdvisory; exception: AuditException }[];
  reported: AuditAdvisory[];
  /** HIGH/CRITICAL findings already present in the base (diff mode only): warning, not blocking. */
  preexisting: AuditAdvisory[];
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
  return exceptionWindowProblem(e.severity, e.addedAt, e.expires);
}

const keysOf = (a: AuditAdvisory): string[] =>
  a.findings.length > 0
    ? a.findings.map((f) => `${a.github_advisory_id}|${a.module_name}|${f.version}`)
    : [`${a.github_advisory_id}|${a.module_name}|`];

/** A finding is new when any (advisory, package, version) of it is absent from the baseline. */
const isNew = (a: AuditAdvisory, baseline: Set<string> | undefined): boolean =>
  baseline === undefined || keysOf(a).some((k) => !baseline.has(k));

export function evaluateAudit(
  advisories: AuditAdvisory[],
  exceptions: AuditException[],
  today: string,
  /** Audit of the base. When given, only findings absent from it can block (diff mode). */
  baseline?: AuditAdvisory[],
): GateResult {
  const baselineKeys = baseline ? new Set(baseline.flatMap(keysOf)) : undefined;
  const result: GateResult = {
    blocking: [],
    accepted: [],
    expired: [],
    reported: [],
    preexisting: [],
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
    // A "high" exception never covers a CRITICAL advisory (re-rated: needs a new 7-day review).
    const exception = valid.find(
      (e) =>
        e.advisory === advisory.github_advisory_id &&
        e.package === advisory.module_name &&
        (e.severity === "critical" || advisory.severity === "high"),
    );
    const fresh = isNew(advisory, baselineKeys);
    if (!exception) {
      if (fresh) result.blocking.push(advisory);
      else result.preexisting.push(advisory);
      continue;
    }
    used.add(exception);
    if (exception.expires >= today) result.accepted.push({ advisory, exception });
    else if (fresh) result.expired.push({ advisory, exception });
    else result.preexisting.push(advisory);
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

/** `pnpm audit --prod` of the workspace at `cwd`; fails closed when pnpm prints nothing. */
function runAudit(cwd: string): AuditAdvisory[] {
  let raw: string;
  try {
    raw = execFileSync("pnpm", ["audit", "--prod", "--json"], {
      cwd,
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
  return Object.values(report.advisories ?? {});
}

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });

const gitOk = (root: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The commit to compare with, or null (→ strict mode). */
function resolveBase(root: string, arg: string): string | null {
  if (arg !== "auto") return arg;
  const before = process.env.BEFORE ?? "";
  if (
    process.env.GITHUB_REF === "refs/heads/main" &&
    /^[0-9a-f]{40}$/.test(before) &&
    !/^0+$/.test(before) &&
    gitOk(root, ["cat-file", "-e", `${before}^{commit}`])
  )
    return before; // push to main: what the merge changed
  try {
    return git(root, ["merge-base", "origin/main", "HEAD"]).trim();
  } catch {
    return null;
  }
}

const MANIFEST = /(^|\/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^\.npmrc$/;

/** Audit of the base: its lockfile and manifests are materialized in a temp dir (no install). */
function auditBase(root: string, base: string, headAudit: AuditAdvisory[]): AuditAdvisory[] {
  const files = git(root, ["ls-tree", "-r", "--name-only", base])
    .split("\n")
    .filter((f) => MANIFEST.test(f) && f.split("/").length <= 3 && !f.includes("node_modules"));
  // Same lockfile and manifests: nothing can have been introduced, the audit would be identical.
  if (gitOk(root, ["diff", "--quiet", base, "HEAD", "--", ...files])) return headAudit;
  const dir = mkdtempSync(join(tmpdir(), "audit-base-"));
  for (const f of files) {
    const target = join(dir, f);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(root, ["show", `${base}:${f}`]));
  }
  return runAudit(dir);
}

function main(): void {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const exceptions = JSON.parse(
    readFileSync(new URL("../../../../security/audit-exceptions.json", import.meta.url), "utf8"),
  ) as { exceptions: AuditException[] };
  const head = runAudit(root);
  const baseArg = process.argv.includes("--base")
    ? (process.argv[process.argv.indexOf("--base") + 1] ?? "auto")
    : null;
  let baseline: AuditAdvisory[] | undefined;
  if (baseArg !== null) {
    const base = resolveBase(root, baseArg);
    if (base === null) {
      out("::warning::Cannot resolve the base commit: strict mode (every finding counts)");
    } else {
      baseline = auditBase(root, base, head);
      out(`diff mode: only findings absent from ${base.slice(0, 10)} can block`);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const r = evaluateAudit(head, exceptions.exceptions, today, baseline);

  const line = (a: AuditAdvisory) =>
    `${a.severity.toUpperCase()} ${a.github_advisory_id} ${a.module_name} ${a.findings.map((f) => f.version).join(",")} (fix: ${a.patched_versions}) — ${a.title}`;
  for (const a of r.blocking) out(`::error::BLOCKING ${line(a)}`);
  for (const { advisory, exception } of r.expired)
    out(`::error::EXPIRED EXCEPTION (${exception.expires}) ${line(advisory)}`);
  for (const { exception, problem } of r.invalid)
    out(`::error::INVALID EXCEPTION ${exception.advisory ?? "?"}: ${problem}`);
  for (const { advisory, exception } of r.accepted)
    out(`accepted until ${exception.expires}: ${line(advisory)}`);
  for (const a of r.preexisting)
    out(
      `::warning::Pre-existing, not introduced by this change (nightly scan owns it): ${line(a)}`,
    );
  for (const e of r.stale)
    out(`::warning::Stale exception (matches nothing now, remove it): ${e.advisory} ${e.package}`);
  out(`reported (moderate/low, not blocking): ${r.reported.length}`);
  if (!gatePasses(r)) process.exit(1);
  out("audit gate: OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
