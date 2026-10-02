import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The version an image declares must be the version released (phase 12 M4). The first published
 * images (v0.12.0) said "main": the build job's metadata step had no tag, so
 * org.opencontainers.image.version came from the git ref, and deploy/bin/fetch-bundle.sh
 * (which refuses a mismatch) stopped the first deploy. These checks keep the fix in place.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const script = join(ROOT, "scripts/ci/image-version-check.sh");
const has = (cmd: string) =>
  spawnSync("bash", ["-c", `command -v ${cmd} >/dev/null && echo yes`], {
    encoding: "utf8",
  }).stdout.includes("yes");
const bash = has("true");
const jq = has("jq"); // present on the CI runners; the "published" mode needs it

describe("release workflow: the image version comes from the release tag", () => {
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  merge:"));

  it("the build job gives the metadata step the semver tag, not just the git ref", () => {
    const meta = build.slice(build.indexOf("id: meta"), build.indexOf("# 1. Build once"));
    expect(meta).toContain(
      "type=semver,pattern={{version}},value=${{ needs.release-please.outputs.tag_name }}",
    );
  });

  it("the smoke step enforces the declared version before anything is pushed", () => {
    const smoke = build.indexOf("Container smoke test");
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(build.indexOf("Push by digest"));
    expect(build.slice(smoke, build.indexOf("OS-package vulnerabilities"))).toContain(
      "EXPECTED_VERSION: ${{ needs.release-please.outputs.version }}",
    );
    for (const app of ["api", "admin"]) {
      expect(readFileSync(join(ROOT, `scripts/ci/${app}-container-smoke.sh`), "utf8")).toContain(
        'bash "$(dirname "$0")/image-version-check.sh" local "$image" "$EXPECTED_VERSION"',
      );
    }
  });

  it("after publishing, every platform of the multi-arch image is checked", () => {
    const merge = workflow.slice(workflow.indexOf("  merge:"));
    // The job runs a repo script, so it must check the tag out; one app failing must not cancel the other.
    expect(merge).toContain("actions/checkout@");
    expect(merge).toContain("fail-fast: false");
    expect(merge.indexOf("actions/checkout@")).toBeLessThan(
      merge.indexOf("image-version-check.sh"),
    );
    expect(merge).toContain(
      'bash scripts/ci/image-version-check.sh published "$IMAGE:$VERSION" "$VERSION"',
    );
  });
});

describe.skipIf(!bash)("image-version-check.sh (with a fake docker)", () => {
  function run(mode: string, expected: string, dockerBody: string) {
    const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
    const shim = join(dir, "docker");
    writeFileSync(shim, `#!/usr/bin/env bash\n${dockerBody}\n`);
    chmodSync(shim, 0o755);
    return spawnSync("bash", [script, mode, "img:1", expected], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
    });
  }
  const label = (v: string) => `echo '${v}'`;
  const platforms = (a: string, b: string) =>
    `cat <<'EOF'\n{"linux/amd64":{"config":{"Labels":{"org.opencontainers.image.version":"${a}"}}},"linux/arm64":{"config":{"Labels":{"org.opencontainers.image.version":"${b}"}}}}\nEOF`;

  it("local: passes on a match, fails on 'main'", () => {
    expect(run("local", "0.12.1", label("0.12.1")).status).toBe(0);
    const bad = run("local", "0.12.1", label("main"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("declares version 'main', expected '0.12.1'");
  });

  it.skipIf(!jq)("published: both platforms must declare the version", () => {
    expect(run("published", "0.12.1", platforms("0.12.1", "0.12.1")).status).toBe(0);
    const bad = run("published", "0.12.1", platforms("0.12.1", "main"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("linux/arm64");
  });

  it.skipIf(!jq)("published: a single-platform image is not enough", () => {
    const one = `cat <<'EOF'\n{"linux/amd64":{"config":{"Labels":{"org.opencontainers.image.version":"0.12.1"}}}}\nEOF`;
    expect(run("published", "0.12.1", one).status).toBe(1);
  });
});
