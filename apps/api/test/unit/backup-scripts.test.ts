import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The backup bucket is APPEND-ONLY for the VM (ADR-026). The behaviour of the PowerShell tool is
 * tested by scripts/oci/tests/setup-backup-bucket.tests.ps1 (fake oci, run by hand on Windows) and the
 * upload path by scripts/deploy/local-harness.sh (fake CLI image); CI cannot run either, so these
 * static guards keep the properties that matter.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8");

const setup = read("scripts/oci/setup-backup-bucket.ps1");
const backup = read("deploy/bin/backup.sh");
const selftest = read("deploy/bin/backup-selftest.sh");

const imageOf = (text: string): string | undefined => /^OCI_CLI_IMAGE="([^"]+)"$/m.exec(text)?.[1];

describe("setup-backup-bucket.ps1 (static guards)", () => {
  it("is plain ASCII (Windows PowerShell 5.1 reads a BOM-less file as ANSI)", () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(setup)).toBe(true);
  });

  it("gives the VM only create + inspect on ONE bucket, never read / overwrite / delete", () => {
    expect(setup).toContain("request.permission = 'OBJECT_CREATE'");
    expect(setup).toContain("request.permission = 'OBJECT_INSPECT'");
    expect(setup).toContain("target.bucket.name = '$BucketName'");
    const vmStatements = setup
      .split("\n")
      .filter((line) => line.includes('"Allow $dg '))
      .join("\n");
    expect(vmStatements).not.toMatch(
      /OBJECT_READ|OBJECT_DELETE|OBJECT_OVERWRITE|manage object-family|manage buckets/,
    );
  });

  it("matches exactly one instance, not a compartment or the whole tenancy", () => {
    expect(setup).toContain(`"instance.id = '$InstanceId'"`);
    expect(setup).not.toMatch(/instance\.compartment\.id|ALL\s*\{/);
  });

  it("creates a private bucket and refuses to continue when it is public", () => {
    expect(setup).toContain('"--public-access-type", "NoPublicAccess"');
    expect(setup).toContain("exists and is PUBLIC");
  });

  it("never writes to ~/.oci", () => {
    expect(setup).not.toMatch(/(Set-Content|Add-Content|Out-File|Remove-Item)[^\r\n]*\.oci/);
  });
});

describe("backup.sh OCI upload path", () => {
  it("is append-only: --no-overwrite, never --force, namespace given explicitly", () => {
    expect(backup).toContain("--no-overwrite");
    expect(backup).not.toMatch(/--force/);
    expect(backup).toContain('--namespace-name "$namespace"');
    expect(backup).toContain("--auth instance_principal");
  });

  it("runs the CLI as root without capabilities (the files are root's, mode 600) with a memory cap", () => {
    expect(backup).toContain(
      "--user 0:0 --cap-drop ALL --security-opt no-new-privileges:true --memory 192m",
    );
  });

  it("pins the same CLI image, by digest, in backup.sh and backup-selftest.sh", () => {
    const image = imageOf(backup);
    expect(image).toMatch(/^ghcr\.io\/oracle\/oci-cli:[0-9]+@sha256:[0-9a-f]{64}$/);
    expect(imageOf(selftest)).toBe(image);
  });

  it("only honours the fake CLI image override in the local harness", () => {
    expect(backup).toContain('[ "$SMARTOPS_LOCAL" = "1" ] && [ -n "${SMARTOPS_OCI_CLI_IMAGE:-}" ]');
  });
});

describe("backup-selftest.sh", () => {
  it("checks that overwrite, delete and read are refused", () => {
    for (const refused of ["--force", "os object delete", "os object get", "os bucket delete"]) {
      expect(selftest).toContain(refused);
    }
    expect(selftest.match(/expect_denied "/g)?.length).toBe(5);
  });

  it("leaves a single probe object under selftest/ only", () => {
    expect(selftest).toContain('name="selftest/$stamp/probe.txt"');
  });
});
