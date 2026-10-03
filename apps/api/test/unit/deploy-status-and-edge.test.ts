import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("Caddy edge body limit", () => {
  const caddyfile = read("deploy/Caddyfile");
  const app = read("apps/api/src/app.ts");

  it("is the same size as the API's JSON limit, so oversized bodies stop at the edge", () => {
    const edge = /request_body\s*\{\s*max_size\s+(\d+)MiB\s*\}/.exec(caddyfile);
    const api = /express\.json\(\{ limit: "(\d+)mb" \}\)/.exec(app);
    expect(edge?.[1]).toBeDefined();
    expect(api?.[1]).toBeDefined();
    expect(edge?.[1]).toBe(api?.[1]);
  });
});

/**
 * deploy/bin/status.sh against a fake docker. `docker compose ps --format 'table … {{.Health}} …'`
 * printed "<no value>" as the Health column title (Compose has no title for it), so the table is built
 * by the script itself from plain tab-separated rows.
 */
const bash =
  spawnSync("bash", ["-c", "command -v awk >/dev/null && echo yes"], {
    encoding: "utf8",
  }).stdout.trim() === "yes";

const FAKE_DOCKER = `#!/usr/bin/env bash
case "$*" in
  *" ps "*) printf 'admin\\trunning\\thealthy\\t2 hours ago\\ncaddy\\trunning\\t\\t2 hours ago\\napi\\texited\\tunhealthy\\t5 minutes ago\\n' ;;
  *stats*) printf 'NAME\\tCPU %%\\tMEM USAGE / LIMIT\\nsmartops-demo-api-1\\t1.0%%\\t160MiB / 320MiB\\n' ;;
esac
`;

describe.skipIf(!bash)("status.sh container table", () => {
  it("prints our own header, a dash for no healthcheck, and never '<no value>'", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const bin = join(dir, "bin");
    const etc = join(dir, "etc");
    const state = join(dir, "state");
    for (const d of [bin, etc, state]) mkdirSync(d);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(state, "current"), "0.14.0\n");
    const posix = (p: string) => p.replace(/\\/g, "/");
    const r = spawnSync(
      "bash",
      [
        "-c",
        `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH"; bash "$SCRIPT"`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SMARTOPS_LOCAL: "1",
          SMARTOPS_ETC: posix(etc),
          SMARTOPS_HOME: posix(dir),
          FAKE_BIN: posix(bin),
          SCRIPT: posix(join(ROOT, "deploy/bin/status.sh")),
        },
        timeout: 60_000,
      },
    );
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain("<no value>");
    expect(out).toMatch(/SERVICE\s+STATE\s+HEALTH\s+UP FOR/);
    expect(out).toMatch(/admin\s+running\s+healthy\s+2 hours ago/);
    expect(out).toMatch(/caddy\s+running\s+-\s+2 hours ago/);
    expect(out).toMatch(/api\s+exited\s+unhealthy\s+5 minutes ago/);
  });

  it("does not ask Compose for a 'table' format again", () => {
    const script = read("deploy/bin/status.sh");
    expect(script).not.toMatch(/ps --format 'table/);
  });
});
