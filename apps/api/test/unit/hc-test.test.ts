import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * deploy/bin/hc-test.sh against a fake `curl`. Healthchecks.io answers "200 OK (not found)" for a
 * well-formed UUID that does not exist (checked in its ping API docs, 2026-10-03), so a typo in
 * monitor.env looks like success unless the BODY is read.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = join(ROOT, "deploy/bin/hc-test.sh");
const bash =
  spawnSync("bash", ["-c", "command -v mktemp >/dev/null && echo yes"], {
    encoding: "utf8",
  }).stdout.trim() === "yes";

const KNOWN = {
  monitor: "11111111-1111-4111-8111-111111111111",
  boot: "22222222-2222-4222-8222-222222222222",
  backup: "33333333-3333-4333-8333-333333333333",
};
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const url = (uuid: string) => `https://hc-ping.com/${uuid}`;

// Emulates: curl … -o <body file> -w '%{http_code}' … <url>; records "<method path>" in $FAKE_LOG.
const FAKE_CURL = `#!/usr/bin/env bash
out=""; target=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[i]}" = "-o" ] && out="\${args[i+1]}"
  target="\${args[i]}"
done
path="\${target#https://hc-ping.com/}"
echo "$path" >>"$FAKE_LOG"
uuid="\${path%%/*}"
case " $FAKE_KNOWN " in
  *" $uuid "*) printf 'OK' >"$out"; printf '200' ;;
  *) printf 'OK (not found)' >"$out"; printf '200' ;;
esac
`;

function run(
  monitorEnv: string,
  backupEnv: string,
  args: string[] = [],
): { code: number; out: string; log: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "hctest-"));
  const bin = join(dir, "bin");
  const etc = join(dir, "etc");
  for (const d of [bin, etc]) mkdirSync(d);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(etc, "monitor.env"), monitorEnv);
  writeFileSync(join(etc, "backup.env"), backupEnv);
  writeFileSync(join(dir, "calls.log"), "");
  const posix = (p: string) => p.replace(/\\/g, "/");
  const r = spawnSync(
    "bash",
    [
      "-c",
      `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH"; bash "$SCRIPT" "$@"`,
      "hc-test",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SMARTOPS_LOCAL: "1",
        SMARTOPS_ETC: posix(etc),
        SMARTOPS_HOME: posix(dir),
        FAKE_BIN: posix(bin),
        FAKE_LOG: posix(join(dir, "calls.log")),
        FAKE_KNOWN: Object.values(KNOWN).join(" "),
        SCRIPT: posix(SCRIPT),
      },
      timeout: 60_000,
    },
  );
  const log = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, log };
}

const good = (): [string, string] => [
  `HC_MONITOR_URL=${url(KNOWN.monitor)}\nHC_BOOT_URL=${url(KNOWN.boot)}\n`,
  `HC_BACKUP_URL=${url(KNOWN.backup)}\n`,
];

describe.skipIf(!bash)("hc-test.sh against a fake curl", () => {
  it("logs one /log ping per configured check, changes no status, prints no URL", () => {
    const [m, b] = good();
    const r = run(m, b);
    expect(r.out).toContain("HC TEST PASSED (3 checked)");
    expect(r.log.sort()).toEqual(
      [`${KNOWN.monitor}/log`, `${KNOWN.boot}/log`, `${KNOWN.backup}/log`].sort(),
    );
    for (const uuid of [...Object.values(KNOWN), "hc-ping.com"]) expect(r.out).not.toContain(uuid);
    expect(r.code).toBe(0);
  });

  it("catches a UUID that does not exist even though Healthchecks answers 200", () => {
    const r = run(`HC_MONITOR_URL=${url(UNKNOWN)}\n`, good()[1]);
    expect(r.out).toContain("FAIL  monitor: Healthchecks says the check does not exist");
    expect(r.out).toContain("HC TEST FAILED (1)");
    expect(r.code).toBe(1);
  });

  it("refuses a URL that is not a Healthchecks ping URL without sending anything to it", () => {
    for (const bad of [
      `http://hc-ping.com/${KNOWN.monitor}`,
      `https://evil.example/${KNOWN.monitor}`,
      "https://hc-ping.com/not-a-uuid",
    ]) {
      const r = run(`HC_MONITOR_URL=${bad}\n`, "");
      expect(r.out).toContain("FAIL  monitor: the URL is not a Healthchecks ping URL");
      expect(r.log).toEqual([]);
      expect(r.code).toBe(1);
    }
  });

  it("accepts the <ping-key>/<slug> form", () => {
    const r = run("HC_MONITOR_URL=https://hc-ping.com/AbCdEfGhIjKlMnOp/smartops-monitor\n", "");
    expect(r.log).toEqual(["AbCdEfGhIjKlMnOp/smartops-monitor/log"]);
  });

  it("--fail sends a /fail to that one check only", () => {
    const [m, b] = good();
    const r = run(m, b, ["--fail", "backup"]);
    expect(r.log).toEqual([`${KNOWN.backup}/fail`]);
    expect(r.out).toContain("SENT  backup");
    expect(r.code).toBe(0);
  });

  it("stops when nothing is configured", () => {
    const r = run("", "");
    expect(r.out).toContain("no Healthchecks URL is configured");
    expect(r.code).not.toBe(0);
  });

  it("rejects an unknown --fail target", () => {
    const [m, b] = good();
    const r = run(m, b, ["--fail", "everything"]);
    expect(r.code).not.toBe(0);
    expect(r.log).toEqual([]);
  });
});
