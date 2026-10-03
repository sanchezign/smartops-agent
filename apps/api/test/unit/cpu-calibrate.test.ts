import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** deploy/bin/cpu-calibrate.sh with canned /proc/stat snapshots (user nice system idle iowait irq softirq steal). */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = join(ROOT, "deploy/bin/cpu-calibrate.sh").replace(/\\/g, "/");
const bash =
  spawnSync("bash", ["-c", "command -v awk >/dev/null && echo yes"], {
    encoding: "utf8",
  }).stdout.trim() === "yes";

function run(snapshots: string[], args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "cpucal-"));
  const file = join(dir, "seq.txt");
  writeFileSync(file, `${snapshots.join("\n")}\n`);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PROC_STAT_SEQUENCE: file.replace(/\\/g, "/") },
    timeout: 30_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!bash)("cpu-calibrate.sh", () => {
  const snapshots = [
    "cpu  1000 0 500 8000 100 0 0 0",
    // +40 user +20 system (busy 60), +890 idle, +10 iowait, +40 steal: total 1000
    "cpu  1040 0 520 8890 110 0 0 40",
    // +1000 idle only
    "cpu  1040 0 520 9890 110 0 0 40",
    // +250 user +50 irq (busy 300), +700 idle: total 1000
    "cpu  1290 0 520 10590 110 50 0 40",
  ];

  it("computes busy, steal and iowait per interval from the counter deltas, and a summary", () => {
    const r = run(snapshots, ["3"]);
    const rows = r.out.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    expect(rows).toHaveLength(3);
    const cols = rows.map((l) => l.trim().split(/\s+/).slice(1).map(Number));
    expect(cols).toEqual([
      [6, 4, 1],
      [0, 0, 0],
      [30, 0, 0],
    ]);
    expect(r.out).toContain("samples=3  mean busy=12.0%  max=30.0%  p95=30.0%");
    expect(r.code).toBe(0);
  });

  it("stops cleanly when the snapshots run out", () => {
    const r = run(snapshots.slice(0, 2), ["5"]);
    expect(r.out).toContain("samples=1");
    expect(r.code).toBe(0);
  });

  it("rejects a bad number of minutes", () => {
    for (const bad of ["0", "abc", "999"]) {
      const r = run(snapshots, [bad]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("usage:");
    }
  });
});
