import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 0.12.3 shipped timer drop-ins with `OnCalendar=*-*-* 20` / `* 50` (the minutes of "02:20"): a
 * wrong string expansion in host-setup.sh. systemd rejected them and the automatic updates never
 * ran. These tests render the drop-ins exactly as host-setup.sh does and make systemd judge them.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const LIB = `${ROOT}deploy/lib/apt-timer.sh`;
const setup = readFileSync(`${ROOT}deploy/bin/host-setup.sh`, "utf8");

const has = (cmd: string) =>
  spawnSync("bash", ["-c", `command -v ${cmd} >/dev/null && echo yes`], {
    encoding: "utf8",
  }).stdout.includes("yes");
const bash = has("true");
const systemdAnalyze = has("systemd-analyze"); // on the CI runners; not on Windows / macOS

function render(time: string) {
  return spawnSync(
    "bash",
    ["-c", `. "${LIB.replaceAll("\\", "/")}"; render_apt_timer "$1"`, "_", time],
    {
      encoding: "utf8",
    },
  );
}

/** The (timer, time) pairs host-setup.sh really passes to render_apt_timer. */
const pairs = [...setup.matchAll(/"(apt-daily(?:-upgrade)?) (\d{2}:\d{2})"/g)].map((m) => ({
  name: m[1]!,
  time: m[2]!,
}));

describe.skipIf(!bash)("apt timers (host-setup.sh)", () => {
  it("host-setup.sh moves both apt timers, through the validated renderer", () => {
    expect(pairs.map((p) => p.name)).toEqual(["apt-daily", "apt-daily-upgrade"]);
    expect(setup).toContain('render_apt_timer "$at"');
    // The expansion that produced "20" and "50" must never come back.
    expect(setup).not.toMatch(/\$\{timer##\*:\}/);
  });

  it("renders a full OnCalendar line with the time, not only its minutes", () => {
    for (const { time } of pairs) {
      const out = render(time);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain(`OnCalendar=\nOnCalendar=*-*-* ${time}:00\n`);
      expect(out.stdout).toContain("RandomizedDelaySec=5min");
      expect(out.stdout).toContain("Persistent=true");
    }
  });

  it("refuses what systemd would reject", () => {
    for (const bad of ["20", "50", "2:20", "25:00", "02:60", "", "02:20:99", "ab:cd"]) {
      const out = render(bad);
      expect(out.status, `"${bad}" should be refused`).toBe(1);
      expect(out.stderr).toContain("invalid time for a timer");
    }
  });

  it.skipIf(!systemdAnalyze)("systemd-analyze accepts every OnCalendar the script writes", () => {
    for (const { time } of pairs) {
      const out = render(time);
      const line = out.stdout
        .split("\n")
        .filter((l) => l.startsWith("OnCalendar=") && l.length > 11)[0]!;
      const spec = line.slice("OnCalendar=".length);
      const check = spawnSync("systemd-analyze", ["calendar", spec], { encoding: "utf8" });
      expect(check.status, `${spec}: ${check.stderr}`).toBe(0);
    }
  });

  it.skipIf(!systemdAnalyze)("…and it does reject the 0.12.3 values (the check is real)", () => {
    for (const spec of ["*-*-* 20", "*-*-* 50"]) {
      expect(
        spawnSync("systemd-analyze", ["calendar", spec], { encoding: "utf8" }).status,
      ).not.toBe(0);
    }
  });
});
