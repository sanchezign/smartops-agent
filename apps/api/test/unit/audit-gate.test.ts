import { describe, expect, it } from "vitest";
import {
  evaluateAudit,
  gatePasses,
  type AuditAdvisory,
  type AuditException,
} from "../../scripts/security/audit-gate.js";

/** Dependency audit gate (phase 11 M3): high/critical block unless excepted until a date. */

const adv = (id: string, pkg: string, severity: string): AuditAdvisory => ({
  github_advisory_id: id,
  module_name: pkg,
  severity,
  title: "t",
  patched_versions: ">=9",
  findings: [{ version: "1.0.0", paths: ["a>b"] }],
});
const exc = (id: string, pkg: string, expires = "2026-10-27"): AuditException => ({
  advisory: id,
  package: pkg,
  reason: "not reachable: only our own build-time input",
  severity: "high",
  expires,
  addedAt: "2026-09-27",
});
const A = "GHSA-6g55-p6wh-862q";
const B = "GHSA-r28c-9q8g-f849";

describe("audit gate", () => {
  it("blocks a high or critical finding without an exception; reports moderate/low only", () => {
    const r = evaluateAudit(
      [
        adv(A, "postcss", "high"),
        adv(B, "x", "critical"),
        adv("GHSA-qx2v-qp2m-jg93", "y", "moderate"),
      ],
      [],
      "2026-09-27",
    );
    expect(r.blocking.map((a) => a.module_name)).toEqual(["postcss", "x"]);
    expect(r.reported).toHaveLength(1);
    expect(gatePasses(r)).toBe(false);
  });

  it("accepts an excepted finding until its expiry date (inclusive), then blocks again", () => {
    const findings = [adv(A, "postcss", "high")];
    expect(gatePasses(evaluateAudit(findings, [exc(A, "postcss")], "2026-10-27"))).toBe(true);
    const later = evaluateAudit(findings, [exc(A, "postcss")], "2026-10-28");
    expect(later.expired).toHaveLength(1);
    expect(gatePasses(later)).toBe(false);
  });

  it("an exception must match both the advisory and the package", () => {
    const r = evaluateAudit([adv(A, "postcss", "high")], [exc(A, "other-package")], "2026-09-27");
    expect(r.blocking).toHaveLength(1);
    expect(r.stale).toHaveLength(1);
  });

  it("malformed exceptions block (no reason, bad date, not a GHSA id, expiry before creation)", () => {
    const bad: AuditException[] = [
      { ...exc(A, "postcss"), reason: "ok" },
      { ...exc(A, "postcss"), expires: "31/10/2026" },
      { ...exc("CVE-2026-1", "postcss") },
      { ...exc(A, "postcss"), expires: "2026-01-01" },
    ];
    for (const e of bad) {
      const r = evaluateAudit([], [e], "2026-09-27");
      expect(r.invalid, JSON.stringify(e)).toHaveLength(1);
      expect(gatePasses(r)).toBe(false);
    }
  });

  it("the versioned exceptions file itself is valid", async () => {
    const { readFileSync } = await import("node:fs");
    const file = JSON.parse(
      readFileSync(new URL("../../../../security/audit-exceptions.json", import.meta.url), "utf8"),
    ) as { exceptions: AuditException[] };
    const r = evaluateAudit([], file.exceptions, "2026-09-27");
    expect(r.invalid).toEqual([]);
  });
});
