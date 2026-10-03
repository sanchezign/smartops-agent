import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * deploy/bin/backup-selftest.sh against a fake `docker` that behaves like the real OCI CLI container.
 *
 * The behaviours below were checked on 2026-10-03 against the official oci-cli image and a stateful
 * fake Object Storage endpoint, and against the real VM: with --no-overwrite the CLI does a HEAD
 * first and, if the object exists, SKIPS the upload and EXITS 0 ("The object already exists and was
 * not overwritten"), so an exit code cannot prove the policy refused anything. The first version of
 * the selftest read that exit code and reported a false "it WORKED". It must now compare the object.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SELFTEST = join(ROOT, "deploy/bin/backup-selftest.sh");
const bash =
  spawnSync("bash", ["-c", "command -v md5sum >/dev/null && echo yes"], {
    encoding: "utf8",
  }).stdout.trim() === "yes";

const FAKE_DOCKER = `#!/usr/bin/env bash
# Emulates: docker run … <image> --auth instance_principal os object|bucket <cmd> …
state="$FAKE_STATE"; mode="$FAKE_MODE"
host=""; args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[i]}" = "-v" ] && host="\${args[i+1]%:/w}"
done
while [ $# -gt 0 ] && [ "$1" != "instance_principal" ]; do shift; done
shift
group="$1 $2"; cmd="$3"; shift 3
file=""; name=""; flags=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="\${2/#\\/w/$host}"; shift ;;
    --name | --object-name) name="$2"; shift ;;
    --no-overwrite | --force) flags="$flags $1" ;;
  esac
  shift
done
obj="$state/obj"
etag() { md5sum "$obj" | cut -d' ' -f1; }
case "$group $cmd" in
  "os object put")
    if [ -f "$obj" ]; then
      case "$flags" in
        *--force*) [ "$mode" = wide-force ] || { echo "NotAuthorizedOrNotFound" >&2; exit 1; }; cp "$file" "$obj"; exit 0 ;;
        *--no-overwrite*)
          if [ "$mode" = cli-overwrites-silently ]; then cp "$file" "$obj"; exit 0; fi
          echo "The object already exists and was not overwritten" >&2; exit 0 ;;
      esac
    fi
    cp "$file" "$obj"; echo '{"etag":"x"}' ;;
  "os object list") echo '{"data":[{"name":"'"$name"'"}]}' ;;
  "os object head")
    [ "$mode" = no-inspect ] && { echo "NotAuthorizedOrNotFound" >&2; exit 1; }
    printf '{\\n  "content-length": "%s",\\n  "date": "now",\\n  "etag": "\\\\"%s\\\\"",\\n  "server": "x"\\n}\\n' "$(wc -c <"$obj" | tr -d ' ')" "$(etag)" ;;
  *) [ "$mode" = wide-delete ] && [ "$cmd" = delete ] && [ "$group" = "os object" ] && { rm -f "$obj"; exit 0; }
     echo "NotAuthorizedOrNotFound" >&2; exit 1 ;;
esac
`;

function run(mode: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "selftest-"));
  const bin = join(dir, "bin");
  const etc = join(dir, "etc");
  const state = join(dir, "state");
  for (const d of [bin, etc, state]) mkdirSync(d);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(etc, "backup.env"), "OCI_BUCKET=smartops-backups\nOCI_NAMESPACE=fakens\n");
  const posix = (p: string) => p.replace(/\\/g, "/");
  const r = spawnSync(
    "bash",
    [
      "-c",
      `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH"; bash "$SELFTEST"`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SMARTOPS_LOCAL: "1",
        SMARTOPS_ETC: posix(etc),
        SMARTOPS_HOME: posix(dir),
        FAKE_BIN: posix(bin),
        FAKE_STATE: posix(state),
        FAKE_MODE: mode,
        SELFTEST: posix(SELFTEST),
      },
      timeout: 60_000,
    },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!bash)("backup-selftest.sh against a fake OCI CLI container", () => {
  it("passes when the policy is append-only, even though --no-overwrite exits 0", () => {
    const r = run("policy-ok");
    expect(r.out).toContain("SELFTEST PASSED");
    expect(r.out).toContain(
      "--no-overwrite, the CLI skips it itself) -> the object did not change",
    );
    expect(r.out).toContain("overwrite it (--force): this is the policy -> refused");
    expect(r.code).toBe(0);
  });

  it("fails when the policy lets the VM overwrite (--force works)", () => {
    const r = run("wide-force");
    expect(r.out).toContain("FAIL  overwrite it (--force): this is the policy (it WORKED");
    expect(r.out).toContain("the object CHANGED");
    expect(r.out).toContain("SELFTEST FAILED");
    expect(r.code).toBe(1);
  });

  it("fails when a write with --no-overwrite really replaces the object (an exit code would hide it)", () => {
    const r = run("cli-overwrites-silently");
    expect(r.out).toMatch(/FAIL {2}write the same name again.*the object CHANGED/);
    expect(r.code).toBe(1);
  });

  it("fails when the VM can delete the backup object", () => {
    const r = run("wide-delete");
    expect(r.out).toContain("FAIL  delete it (it WORKED, it must be refused)");
    expect(r.code).toBe(1);
  });

  it("fails when the object's etag cannot be read (no OBJECT_INSPECT) instead of passing blind", () => {
    const r = run("no-inspect");
    expect(r.out).toContain("FAIL  read the new object's etag and size");
    expect(r.code).toBe(1);
  });
});
