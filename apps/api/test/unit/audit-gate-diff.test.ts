import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateAudit,
  exceptionWindowProblem,
  gatePasses,
  MAX_EXCEPTION_DAYS,
  validateException,
  type AuditAdvisory,
  type AuditException,
} from "../../scripts/security/audit-gate.js";

/**
 * Diff mode of the audit gate (ADR-028): only findings the change INTRODUCES block, so an advisory
 * published today cannot turn a pull request red; exceptions have a maximum life by severity.
 */

const GHSA = "GHSA-6g55-p6wh-862q";
const GHSA2 = "GHSA-r28c-9q8g-f849";
const adv = (id: string, pkg: string, severity: string, version = "1.0.0"): AuditAdvisory => ({
  github_advisory_id: id,
  module_name: pkg,
  severity,
  title: "t",
  patched_versions: ">=9",
  findings: [{ version, paths: ["a>b"] }],
});
const exc = (id: string, pkg: string, over: Partial<AuditException> = {}): AuditException => ({
  advisory: id,
  package: pkg,
  reason: "not reachable: only our own build-time input",
  severity: "high",
  expires: "2026-10-27",
  addedAt: "2026-09-27",
  ...over,
});
const TODAY = "2026-10-06";

describe("audit gate — diff mode", () => {
  it("a finding that is also in the base is pre-existing: reported, never blocking", () => {
    const r = evaluateAudit([adv(GHSA, "x", "critical")], [], TODAY, [adv(GHSA, "x", "critical")]);
    expect(r.blocking).toEqual([]);
    expect(r.preexisting).toHaveLength(1);
    expect(gatePasses(r)).toBe(true);
  });

  it("a finding the change introduces blocks (new advisory, or the same advisory on a new version)", () => {
    const base = [adv(GHSA, "x", "high", "1.0.0")];
    const newAdvisory = evaluateAudit([adv(GHSA2, "y", "high")], [], TODAY, base);
    expect(newAdvisory.blocking).toHaveLength(1);
    const newVersion = evaluateAudit([adv(GHSA, "x", "high", "2.0.0")], [], TODAY, base);
    expect(newVersion.blocking).toHaveLength(1);
    expect(gatePasses(newVersion)).toBe(false);
  });

  it("with no baseline it stays strict (the scheduled scan and the fallback)", () => {
    const r = evaluateAudit([adv(GHSA, "x", "high")], [], TODAY);
    expect(r.blocking).toHaveLength(1);
  });

  it("an expired exception on a pre-existing finding is only a warning; on a new one it blocks", () => {
    const e = [exc(GHSA, "x", { expires: "2026-10-01" })];
    const old = evaluateAudit([adv(GHSA, "x", "high")], e, TODAY, [adv(GHSA, "x", "high")]);
    expect(old.expired).toEqual([]);
    expect(old.preexisting).toHaveLength(1);
    expect(gatePasses(old)).toBe(true);
    const fresh = evaluateAudit([adv(GHSA, "x", "high")], e, TODAY, []);
    expect(fresh.expired).toHaveLength(1);
    expect(gatePasses(fresh)).toBe(false);
  });

  it("a valid exception accepts a new finding until its expiry day (inclusive)", () => {
    const e = [exc(GHSA, "x")];
    expect(gatePasses(evaluateAudit([adv(GHSA, "x", "high")], e, "2026-10-27", []))).toBe(true);
    expect(gatePasses(evaluateAudit([adv(GHSA, "x", "high")], e, "2026-10-28", []))).toBe(false);
  });

  it("an invalid exception always blocks, in either mode", () => {
    const bad = exc(GHSA, "x", { reason: "short" });
    expect(gatePasses(evaluateAudit([], [bad], TODAY, []))).toBe(false);
  });

  it("a high exception does not cover a critical advisory (re-rated: needs a new 7-day review)", () => {
    const r = evaluateAudit([adv(GHSA, "x", "critical")], [exc(GHSA, "x")], TODAY, []);
    expect(r.blocking).toHaveLength(1);
    const ok = evaluateAudit(
      [adv(GHSA, "x", "critical")],
      [exc(GHSA, "x", { severity: "critical", expires: "2026-10-04" })],
      "2026-10-01",
      [],
    );
    expect(gatePasses(ok)).toBe(true);
  });

  it("moderate and low findings never block", () => {
    const r = evaluateAudit([adv(GHSA, "x", "moderate")], [], TODAY, []);
    expect(gatePasses(r)).toBe(true);
  });
});

describe("exception maximum life", () => {
  it("CRITICAL ≤ 7 days and HIGH ≤ 30 days from addedAt, boundaries included", () => {
    expect(MAX_EXCEPTION_DAYS).toEqual({ critical: 7, high: 30 });
    expect(exceptionWindowProblem("critical", "2026-10-06", "2026-10-13")).toBeNull();
    expect(exceptionWindowProblem("critical", "2026-10-06", "2026-10-14")).toMatch(/at most 7/);
    expect(exceptionWindowProblem("high", "2026-09-27", "2026-10-27")).toBeNull();
    expect(exceptionWindowProblem("high", "2026-09-27", "2026-10-28")).toMatch(/at most 30/);
  });

  it("an exception without a valid severity is invalid", () => {
    expect(
      validateException({ ...exc(GHSA, "x"), severity: "moderate" as unknown as "high" }),
    ).toMatch(/severity/);
    expect(
      validateException({ ...exc(GHSA, "x"), severity: undefined as unknown as "high" }),
    ).toMatch(/severity/);
  });

  it("every versioned pnpm audit exception respects it", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../../../security/audit-exceptions.json", import.meta.url), "utf8"),
    ) as { exceptions: AuditException[] };
    expect(file.exceptions.length).toBeGreaterThan(0);
    for (const e of file.exceptions) expect(validateException(e), e.advisory).toBeNull();
  });
});

// ── properties ───────────────────────────────────────────────────────────────────────────────
const part = fc.string({
  unit: fc.constantFrom(..."23456789cfghjmpqrvwx".split("")),
  minLength: 4,
  maxLength: 4,
});
const idArb = fc.tuple(part, part, part).map(([a, b, c]) => `GHSA-${a}-${b}-${c}`);
const advArb = fc
  .record({
    id: idArb,
    pkg: fc.constantFrom("a", "b", "c", "d"),
    severity: fc.constantFrom("low", "moderate", "high", "critical"),
    version: fc.constantFrom("1.0.0", "2.0.0"),
  })
  .map((x) => adv(x.id, x.pkg, x.severity, x.version));
const advsArb = fc.array(advArb, { maxLength: 8 });
const dayArb = fc
  .integer({ min: 0, max: 60 })
  .map((n) => new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10));
const excArb = fc
  .record({ a: advArb, severity: fc.constantFrom("high" as const, "critical" as const) })
  .map(({ a, severity }) =>
    exc(a.github_advisory_id, a.module_name, {
      severity,
      addedAt: "2026-09-01",
      expires: severity === "critical" ? "2026-09-08" : "2026-10-01",
    }),
  );

describe("audit gate — properties", () => {
  it("a head that is a subset of the base never fails (no exceptions needed)", () => {
    fc.assert(
      fc.property(advsArb, fc.nat(8), dayArb, (base, cut, today) => {
        const head = base.slice(0, cut);
        expect(gatePasses(evaluateAudit(head, [], today, base))).toBe(true);
      }),
    );
  });

  it("a head identical to the base never fails, whatever the exceptions say", () => {
    fc.assert(
      fc.property(advsArb, fc.array(excArb, { maxLength: 4 }), dayArb, (base, es, today) => {
        const r = evaluateAudit(base, es, today, base);
        expect(r.blocking).toEqual([]);
        expect(r.expired).toEqual([]);
      }),
    );
  });

  it("diff mode never blocks more than strict mode", () => {
    fc.assert(
      fc.property(
        advsArb,
        advsArb,
        fc.array(excArb, { maxLength: 4 }),
        dayArb,
        (head, base, es, today) => {
          const strict = evaluateAudit(head, es, today);
          const diff = evaluateAudit(head, es, today, base);
          const ids = (x: AuditAdvisory[]) =>
            x.map((a) => `${a.github_advisory_id}|${a.module_name}`);
          for (const k of ids(diff.blocking)) expect(ids(strict.blocking)).toContain(k);
          expect(diff.expired.length).toBeLessThanOrEqual(strict.expired.length);
          if (gatePasses(strict)) expect(gatePasses(diff)).toBe(true);
        },
      ),
    );
  });

  it("adding a valid, unexpired exception never turns a pass into a failure", () => {
    fc.assert(
      fc.property(advsArb, advsArb, excArb, (head, base, e) => {
        const before = evaluateAudit(head, [], "2026-09-02", base);
        const after = evaluateAudit(head, [e], "2026-09-02", base);
        if (gatePasses(before)) expect(gatePasses(after)).toBe(true);
        expect(after.blocking.length).toBeLessThanOrEqual(before.blocking.length);
      }),
    );
  });
});
