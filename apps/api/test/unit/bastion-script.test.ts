import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/oci/bastion-connect.ps1 runs on the owner's Windows PC (its behaviour is tested by
 * scripts/oci/tests/bastion-connect.tests.ps1 against a fake oci). CI cannot run PowerShell 5.1, so
 * these static guards keep the properties that matter for a script holding a passphrase.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const text = readFileSync(`${ROOT}scripts/oci/bastion-connect.ps1`, "utf8");

describe("bastion-connect.ps1 (static guards)", () => {
  it("is plain ASCII (Windows PowerShell 5.1 reads a BOM-less file as ANSI)", () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
  });

  it("never persists the passphrase: process-only variable, no config / file / log writes", () => {
    expect(text).toContain("$env:OCI_CLI_PASSPHRASE");
    expect(text).not.toMatch(/pass_phrase\s*=/);
    expect(text).not.toMatch(/(Set-Content|Add-Content|Out-File)[^\r\n]*(PASSPHRASE|passphrase)/);
  });

  it("never writes to ~/.oci", () => {
    expect(text).not.toMatch(/(Set-Content|Add-Content|Out-File|Remove-Item)[^\r\n]*\.oci/);
  });

  it("refuses an open allowlist: it only ever writes <ip>/32", () => {
    expect(text).toContain('$cidr = "$myIp/32"');
    expect(text).not.toContain("0.0.0.0/0");
  });

  it("always cleans up: tunnel, session and ephemeral key in a finally block", () => {
    const finalBlock = text.slice(text.lastIndexOf("} finally {"));
    expect(finalBlock).toContain("Stop-Tunnel");
    expect(finalBlock).toContain("Remove-Session");
    expect(finalBlock).toContain("Remove-Item -Recurse -Force $script:tempDir");
  });

  it("the tunnel's ssh never shares the console: -n and stdin / stdout redirected", () => {
    const tunnel = text.slice(
      text.indexOf("function Start-Tunnel"),
      text.indexOf("function Stop-Tunnel"),
    );
    expect(tunnel).toContain('@("-4", "-n", "-N")');
    expect(tunnel).toContain("-RedirectStandardInput");
    expect(tunnel).toContain("-RedirectStandardOutput");
  });

  it("retries the tunnel while the session spreads its key, and tells key from network", () => {
    const tunnel = text.slice(
      text.indexOf("function Start-Tunnel"),
      text.indexOf("function Stop-Tunnel"),
    );
    expect(tunnel).toContain("while ($true)");
    expect(tunnel).toContain("$TunnelWaitSeconds");
    expect(text).toContain("Permission denied \\(publickey");
    expect(text).toContain("NOT the allowlist");
    expect(text).toContain("NETWORK or the allowlist");
  });

  it("the interactive ssh keeps the option set proven on the real VM (more options broke it)", () => {
    const line = text.split("\n").find((l) => l.includes("$sshOpts = @("))!;
    expect(line.replaceAll(/\s+/g, " ").trim()).toBe(
      '$sshOpts = @("-o", "ServerAliveInterval=30", "-i", $IdentityFile, "-p", "$port")',
    );
  });

  it("logs every tunnel attempt and the live tunnel's output in -SshDebug", () => {
    expect(text).toContain("function Write-SshDebugLog");
    expect(text).toContain("tunnel UP (stderr so far)");
    expect(text).toContain("tunnel closed (everything the live tunnel logged)");
  });

  it("waits for the VM's banner through the tunnel and retries an interactive ssh that never established", () => {
    expect(text).toContain("function Wait-TunnelStable");
    expect(text).toContain('-like "SSH-*"');
    expect(text).toContain("-ne 255");
    expect(text).toContain("$ConnectRetries");
    expect(text).toContain("$ConnectGraceSeconds");
  });

  it("keeps the connection alive (the Bastion drops idle SSH)", () => {
    expect(text).toContain("ServerAliveInterval=30");
  });
});
