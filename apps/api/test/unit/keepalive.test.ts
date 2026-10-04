import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The keep-alive load (ADR-027): one CPU-bound process for up to two hours a night so the demo VM does
 * not look idle to Oracle (CPU p95 < 20 % over 7 days). These tests keep it harmless: lowest priority,
 * no network or disk, off by default, finished long before the apt timers, the backup and the reboot,
 * and invisible to the monitor as a problem. The unit was also run for real under systemd 255 (the
 * Ubuntu 24.04 version) in a container: SCHED_IDLE, only `lo`, /dev/zero readable, root read-only,
 * 21 CPU-seconds in 60 s (= the 35 % quota).
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const posix = (p: string) => p.replace(/\\/g, "/");

const service = read("deploy/systemd/smartops-keepalive.service");
const timer = read("deploy/systemd/smartops-keepalive.timer");
const hostSetup = read("deploy/bin/host-setup.sh");
const monitor = read("deploy/bin/monitor.sh");
const has = (cmd: string) =>
  spawnSync("bash", ["-c", `command -v ${cmd} >/dev/null && echo yes`], {
    encoding: "utf8",
  }).stdout.includes("yes");
const bash = has("true");
const systemdAnalyze = has("systemd-analyze");

const directive = (text: string, key: string): string[] =>
  [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);

describe("keep-alive unit", () => {
  it("runs at the lowest priority and is capped at 35 % of one vCPU", () => {
    expect(directive(service, "Nice")).toEqual(["19"]);
    expect(directive(service, "CPUSchedulingPolicy")).toEqual(["idle"]);
    expect(directive(service, "IOSchedulingClass")).toEqual(["idle"]);
    expect(directive(service, "CPUQuota")).toEqual(["35%"]);
    expect(directive(service, "MemoryMax")).toEqual(["32M"]);
  });

  it("cannot reach the network, the disk, the secrets or Docker", () => {
    for (const [key, value] of [
      ["PrivateNetwork", "yes"],
      ["PrivateDevices", "yes"],
      ["ProtectSystem", "strict"],
      ["ProtectHome", "yes"],
      ["DynamicUser", "yes"],
      ["NoNewPrivileges", "yes"],
    ] as const) {
      expect(directive(service, key), key).toEqual([value]);
    }
    expect(directive(service, "CapabilityBoundingSet")).toEqual([""]);
    const inaccessible = directive(service, "InaccessiblePaths").join(" ");
    for (const path of ["/opt", "/etc/smartops", "/var/lib/docker", "/run/docker.sock"]) {
      expect(inaccessible).toContain(path);
    }
  });

  it("only hashes the kernel's zeros: no files, no sockets, no shell", () => {
    expect(directive(service, "ExecStart")).toEqual([
      "/usr/bin/timeout --signal=TERM ${KEEPALIVE_MINUTES}m /usr/bin/sha256sum /dev/zero",
    ]);
    // timeout ends the run with SIGTERM: its exit status 124 is the normal ending.
    expect(directive(service, "SuccessExitStatus")).toEqual(["124"]);
    // RuntimeMaxSec does not apply to oneshot units; TimeoutStartSec is the backstop.
    expect(directive(service, "RuntimeMaxSec")).toEqual([]);
    expect(directive(service, "TimeoutStartSec")).toEqual(["125min"]);
  });

  it("is OFF unless the switch file says on (the default is off)", () => {
    expect(directive(service, "Environment")).toContain("KEEPALIVE_LOAD=off");
    expect(directive(service, "EnvironmentFile")).toEqual(["-/etc/smartops/keepalive.env"]);
  });

  describe.skipIf(!bash)("the ExecCondition", () => {
    // systemd writes a literal $ as $$ in a command line.
    const body = /^ExecCondition=\/bin\/sh -c '(.*)'$/m.exec(service)?.[1]?.replaceAll("$$", "$");
    const run = (load: string | undefined, minutes: string | undefined) =>
      spawnSync("sh", ["-c", body!], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          ...(load === undefined ? {} : { KEEPALIVE_LOAD: load }),
          ...(minutes === undefined ? {} : { KEEPALIVE_MINUTES: minutes }),
        },
      });

    it("lets it run only for on + a whole number of minutes from 1 to 120", () => {
      expect(body).toBeDefined();
      for (const minutes of ["1", "20", "119", "120"]) {
        expect(run("on", minutes).status, `on/${minutes}`).toBe(0);
      }
    });

    it("skips quietly (exit 1, no failure) when off, missing or the minutes are wrong", () => {
      const skipped: Array<[string | undefined, string | undefined]> = [
        ["off", "120"],
        [undefined, "120"],
        ["ON", "120"],
        ["on", "0"],
        ["on", "121"],
        ["on", "500"],
        ["on", "-5"],
        ["on", "abc"],
        ["on", "12abc"],
        ["on", "1.5"],
        ["on", ""],
        ["on", undefined],
      ];
      for (const [load, minutes] of skipped) {
        const r = run(load, minutes);
        expect(r.status, `${load}/${minutes}`).toBe(1); // 1-254 = skipped without failure
      }
    });

    it("says why when the minutes are wrong", () => {
      expect(run("on", "500").stdout).toContain("KEEPALIVE_MINUTES must be from 1 to 120");
      expect(run("on", "abc").stdout).toContain("KEEPALIVE_MINUTES must be a number");
    });
  });

  it.skipIf(!systemdAnalyze)("systemd-analyze accepts the service and the timer", () => {
    const r = spawnSync(
      "systemd-analyze",
      ["verify", join(ROOT, "deploy/systemd/smartops-keepalive.service")],
      { encoding: "utf8" },
    );
    // Warnings about the file mode / missing optional files are fine; a parse error is not.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(
      /Unknown key|Failed to parse|Invalid|bad setting/i,
    );
    const t = spawnSync("systemd-analyze", ["calendar", "*-*-* 03:00:00 UTC"], {
      encoding: "utf8",
    });
    expect(t.status).toBe(0);
  });
});

/** Minutes since 00:00 UTC. The VM's timers are Montevideo time: UTC-3, no daylight saving since 2015. */
const MONTEVIDEO_TO_UTC_MIN = 3 * 60;
const hm = (h: string, m: string, s = "0") => Number(h) * 60 + Number(m) + Number(s) / 60;

describe("keep-alive schedule: everything explicit in UTC", () => {
  const cal = /^OnCalendar=\*-\*-\* (\d\d):(\d\d):(\d\d) UTC$/m.exec(timer);
  const delay = Number(/^RandomizedDelaySec=(\d+)min$/m.exec(timer)?.[1]);
  const maxMinutes = Number(/"\$\$KEEPALIVE_MINUTES" -le (\d+)/.exec(service)?.[1]);
  const start = cal ? hm(cal[1]!, cal[2]!, cal[3]) : NaN;
  const latestEnd = start + delay + maxMinutes;

  it("starts at 03:00 UTC, with a 5-minute random delay and a 2-hour maximum", () => {
    expect(cal?.slice(1, 4)).toEqual(["03", "00", "00"]);
    expect(delay).toBe(5);
    expect(maxMinutes).toBe(120);
    expect(directive(timer, "Persistent")).toEqual(["false"]);
  });

  it("the host is on Montevideo time, which is where the other timers' clocks come from", () => {
    expect(hostSetup).toContain("timedatectl set-timezone America/Montevideo");
  });

  it("the longest run ends at least 10 minutes before the apt timers (02:20 local = 05:20 UTC)", () => {
    const apt = [...hostSetup.matchAll(/"apt-daily(?:-upgrade)? (\d\d):(\d\d)"/g)].map(
      (m) => hm(m[1]!, m[2]!) + MONTEVIDEO_TO_UTC_MIN, // timers only run LATER than this (random delay)
    );
    expect(apt).toHaveLength(2);
    expect(Math.min(...apt)).toBe(5 * 60 + 20);
    expect(latestEnd).toBeLessThanOrEqual(Math.min(...apt) - 10);
  });

  it("does not meet the backup (03:30 local = 06:30 UTC)", () => {
    const b = /^OnCalendar=\*-\*-\* (\d\d):(\d\d):00$/m.exec(
      read("deploy/systemd/smartops-backup.timer"),
    );
    const backup = hm(b![1]!, b![2]!) + MONTEVIDEO_TO_UTC_MIN;
    expect(backup).toBe(6 * 60 + 30);
    expect(latestEnd).toBeLessThan(backup);
  });

  it("does not meet the automatic reboot (04:00 local = 07:00 UTC)", () => {
    const r = /Automatic-Reboot-Time "(\d\d):(\d\d)"/.exec(hostSetup);
    const reboot = hm(r![1]!, r![2]!) + MONTEVIDEO_TO_UTC_MIN;
    expect(reboot).toBe(7 * 60);
    expect(latestEnd).toBeLessThan(reboot);
  });

  it("the timer states UTC explicitly, so a change of the VM's time zone cannot move it", () => {
    expect(directive(timer, "OnCalendar")[0]).toMatch(/ UTC$/);
  });

  it("is installed (and enabled) by install-units.sh even when the switch is off", () => {
    expect(read("deploy/bin/install-units.sh")).toContain(
      "systemctl enable --now smartops-keepalive.timer",
    );
  });
});

describe("the monitor shows the keep-alive state and never judges it", () => {
  it("adds it to the summary line, not to the problems", () => {
    expect(monitor).toMatch(/summary=.*keepalive \$\(keepalive_state\)/);
    const problemLines = monitor.split("\n").filter((l) => /problems\+=/.test(l));
    expect(problemLines.length).toBeGreaterThan(0);
    for (const line of problemLines) expect(line).not.toMatch(/keepalive|cpu|load/i);
    expect(monitor).not.toMatch(/\/proc\/stat|loadavg|CpuUtil/i);
  });

  describe.skipIf(!bash)("keepalive_state", () => {
    function state(env: string | null, active: string | null): string {
      const dir = mkdtempSync(join(tmpdir(), "kastate-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      if (env !== null) writeFileSync(join(dir, "keepalive.env"), env);
      if (active !== null) {
        writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\necho ${active}\n`);
        chmodSync(join(bin, "systemctl"), 0o755);
      }
      const r = spawnSync(
        "bash",
        [
          "-c",
          `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH"; . "$LIB"; keepalive_state`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SMARTOPS_LOCAL: "1",
            SMARTOPS_ETC: posix(dir),
            SMARTOPS_HOME: posix(dir),
            FAKE_BIN: posix(bin),
            LIB: posix(join(ROOT, "deploy/bin/lib.sh")),
          },
        },
      );
      return r.stdout.trim();
    }

    it("is off without the file, with off, or with anything but on", () => {
      expect(state(null, null)).toBe("off");
      expect(state("KEEPALIVE_LOAD=off\n", null)).toBe("off");
      expect(state("KEEPALIVE_LOAD=maybe\n", null)).toBe("off");
    });

    it("is on, and says when a run is in progress", () => {
      expect(state("KEEPALIVE_LOAD=on\nKEEPALIVE_MINUTES=120\n", "inactive")).toBe("on");
      expect(state("KEEPALIVE_LOAD=on\n", "activating")).toBe("on, running now");
    });
  });
});

describe.skipIf(!bash)("keepalive.sh", () => {
  // A fake systemctl: `start` records what the env file said at that moment and "runs" the unit.
  const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
case "$*" in
  *"start --no-block"*) cat "$KEEPALIVE_ENV" >"$FAKE_STATE/env-at-start" 2>/dev/null || echo "(no file)" >"$FAKE_STATE/env-at-start"; echo 4242 >"$FAKE_STATE/pid" ;;
  *"show"*"MainPID"*) cat "$FAKE_STATE/pid" 2>/dev/null || echo 0 ;;
  stop*) echo stopped >>"$FAKE_STATE/calls"; rm -f "$FAKE_STATE/pid" ;;
  *) : ;;
esac
`;

  function setup(initialEnv: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "kascript-"));
    const bin = join(dir, "bin");
    const etc = join(dir, "etc");
    const state = join(dir, "state");
    for (const d of [bin, etc, state]) mkdirSync(d);
    writeFileSync(join(bin, "systemctl"), FAKE_SYSTEMCTL);
    chmodSync(join(bin, "systemctl"), 0o755);
    const envFile = join(etc, "keepalive.env");
    if (initialEnv !== null) writeFileSync(envFile, initialEnv);
    const run = (...args: string[]) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH"; bash "$SCRIPT" "$@"`,
          "keepalive",
          ...args,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SMARTOPS_LOCAL: "1",
            SMARTOPS_ETC: posix(etc),
            SMARTOPS_HOME: posix(dir),
            KEEPALIVE_ENV: posix(envFile),
            FAKE_BIN: posix(bin),
            FAKE_STATE: posix(state),
            SCRIPT: posix(join(ROOT, "deploy/bin/keepalive.sh")),
          },
          timeout: 60_000,
        },
      );
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };
    const file = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : null);
    const atStart = () => readFileSync(join(state, "env-at-start"), "utf8");
    return { run, file, atStart, state };
  }

  it("is off without a file", () => {
    const s = setup(null);
    const r = s.run("status");
    expect(r.out).toContain("keepalive: off");
    expect(r.out).toContain("missing = off");
  });

  it("on writes the switch with the minutes (default 120), off turns it off and stops a run", () => {
    const s = setup(null);
    expect(s.run("on").code).toBe(0);
    expect(s.file()).toBe("KEEPALIVE_LOAD=on\nKEEPALIVE_MINUTES=120\n");
    expect(s.run("on", "45").code).toBe(0);
    expect(s.file()).toBe("KEEPALIVE_LOAD=on\nKEEPALIVE_MINUTES=45\n");
    expect(s.run("off").code).toBe(0);
    expect(s.file()).toBe("KEEPALIVE_LOAD=off\nKEEPALIVE_MINUTES=45\n");
    expect(readFileSync(join(s.state, "calls"), "utf8")).toContain("stopped");
  });

  it("refuses minutes outside 1-120 and writes nothing", () => {
    const s = setup(null);
    for (const bad of ["0", "121", "500", "abc", "-1", "1.5"]) {
      const r = s.run("on", bad);
      expect(r.code, bad).not.toBe(0);
      expect(r.out).toContain("minutes must be a number from 1 to 120");
    }
    expect(s.file()).toBeNull();
    expect(s.run("test", "999").code).not.toBe(0);
  });

  it("test runs it once with the asked minutes and puts the saved settings back (off + 120)", () => {
    const s = setup("KEEPALIVE_LOAD=off\nKEEPALIVE_MINUTES=120\n");
    const r = s.run("test", "20");
    expect(r.code, r.out).toBe(0);
    expect(s.atStart()).toBe("KEEPALIVE_LOAD=on\nKEEPALIVE_MINUTES=20\n");
    expect(s.file()).toBe("KEEPALIVE_LOAD=off\nKEEPALIVE_MINUTES=120\n");
    expect(r.out).toContain("saved settings untouched");
  });

  it("test with no saved file leaves no file behind (still off)", () => {
    const s = setup(null);
    expect(s.run("test").code).toBe(0);
    expect(s.atStart()).toBe("KEEPALIVE_LOAD=on\nKEEPALIVE_MINUTES=20\n");
    expect(s.file()).toBeNull();
  });

  it("stop and an unknown command", () => {
    const s = setup(null);
    expect(s.run("stop").code).toBe(0);
    const r = s.run("explode");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage: keepalive.sh");
  });
});
