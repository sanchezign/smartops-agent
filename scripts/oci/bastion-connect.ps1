<#
.SYNOPSIS
  Opens an SSH tunnel to the demo VM through OCI Bastion, on demand (phase 12, M3b).
  Runs on YOUR PC (Windows, PowerShell 5.1) with the OCI CLI and a least-privilege IAM user.
  Guide: docs/deploy/bastion-access.md

.DESCRIPTION
  One command does what the Console takes ten clicks for:
    1. finds your current public IPv4 address;
    2. if the bastion's CIDR allowlist is not exactly <that IP>/32, updates it (existing sessions
       are not affected, only new ones);
    3. creates a NEW ephemeral SSH key pair (Oracle: one per session) and a port forwarding
       session to the VM's private IP, port 22 (TTL 3 h, the maximum);
    4. opens the tunnel (ssh -N -L) and, by default, your interactive SSH session on the VM
       (ServerAliveInterval=30: the Bastion drops idle connections);
    5. when you leave: closes the tunnel, DELETES the session and the ephemeral key.

  The API key of the IAM user has its OWN passphrase. It is asked once per run (hidden) and handed
  to the OCI CLI through the process-only variable OCI_CLI_PASSPHRASE: it is never written to a
  file, to the OCI config or to the log. This script only READS the OCI config (to find the
  region); it never writes to ~/.oci.

  -Probe  checks, step by step, which permission the IAM user is missing (used to find the
          narrowest policy: it changes nothing except a throw-away session it deletes).
  -DryRun resolves everything and prints what it would do, without changing anything.

.EXAMPLE
  # first time (saves the bastion OCID in %LOCALAPPDATA%\smartops\bastion.json)
  powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1 -BastionId ocid1.bastion.oc1.sa-saopaulo-1.xxxx
  # next times
  powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1
  # tunnel only (for scp / several terminals): stays open until you press Enter
  powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1 -TunnelOnly
#>
[CmdletBinding()]
param(
  [string]$BastionId = "",
  [string]$OciProfile = "SMARTOPS_BASTION",
  [string]$TargetIp = "10.0.0.21",
  [string]$VmUser = "ubuntu",
  [string]$IdentityFile = (Join-Path $env:USERPROFILE ".ssh\smartops_oci"),
  [int]$LocalPort = 2222,
  [int]$SessionTtlSeconds = 10800,
  [switch]$TunnelOnly,
  [switch]$Probe,
  [switch]$DryRun,
  # Testing / overrides (a fake oci and ssh, a fixed IP or region).
  [string]$OciCommand = "oci",
  [string]$SshCommand = "ssh",
  [string]$SshKeygenCommand = "ssh-keygen",
  [string]$PublicIp = "",
  [string]$Region = "",
  [switch]$NoPassphrase
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$stateDir = Join-Path $env:LOCALAPPDATA "smartops"
$stateFile = Join-Path $stateDir "bastion.json"
$script:tunnel = $null
$script:sessionId = ""
$script:tempDir = ""

function Say([string]$message) { Write-Host ("[bastion] " + $message) }
function Fail([string]$message, [string]$hint = "") {
  Write-Host ("[bastion] ERROR: " + $message) -ForegroundColor Red
  if ($hint) { Write-Host ("[bastion] " + $hint) }
  throw "bastion-connect stopped"
}

# ---------------------------------------------------------------------------------------------
# OCI CLI
# ---------------------------------------------------------------------------------------------
function Invoke-Oci([string[]]$CliArgs) {
  $output = & $OciCommand @CliArgs --profile $OciProfile 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Text = $output }
}

function Get-OciError([string]$text) {
  $code = ""
  if ($text -match '"code":\s*"([A-Za-z]+)"') { $code = $Matches[1] }
  if (-not $code -and $text -match 'ServiceError') { $code = "ServiceError" }
  return $code
}

function Invoke-OciJson([string[]]$CliArgs, [string]$what, [string]$policyHint = "") {
  $r = Invoke-Oci ($CliArgs + @("--output", "json"))
  if ($r.Code -ne 0) {
    $code = Get-OciError $r.Text
    if ($code -eq "NotAuthorizedOrNotFound" -or $code -eq "NotAuthenticated") {
      Fail ("{0}: {1}" -f $what, $code) $policyHint
    }
    $detail = ($r.Text -replace "\s+", " ")
    if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
    Fail ("{0} failed ({1})" -f $what, $detail)
  }
  $start = $r.Text.IndexOf("{")
  if ($start -lt 0) { Fail ("{0}: the OCI CLI answered without JSON" -f $what) }
  return ($r.Text.Substring($start) | ConvertFrom-Json)
}

function Get-RegionFromConfig {
  if ($Region) { return $Region }
  $cfg = $env:OCI_CLI_CONFIG_FILE
  if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE ".oci\config" }
  if (-not (Test-Path $cfg)) { Fail "OCI config not found: $cfg" "Create the profile $OciProfile (docs/deploy/bastion-access.md)." }
  $inSection = $false
  foreach ($line in Get-Content $cfg) {
    if ($line -match '^\s*\[(.+)\]\s*$') { $inSection = ($Matches[1] -eq $OciProfile); continue }
    if ($inSection -and $line -match '^\s*region\s*=\s*(\S+)') { return $Matches[1] }
  }
  Fail "No [$OciProfile] profile with a region in $cfg" "Create it (docs/deploy/bastion-access.md)."
}

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
function Get-PublicIpv4 {
  if ($PublicIp) { return $PublicIp }
  try {
    $ip = ([string](Invoke-RestMethod -Uri "https://checkip.amazonaws.com" -TimeoutSec 15)).Trim()
  } catch {
    Fail "Could not find your public IP (checkip.amazonaws.com)" "Pass it yourself: -PublicIp <a.b.c.d>"
  }
  if ($ip -notmatch '^(\d{1,3}\.){3}\d{1,3}$') { Fail "Unexpected answer when looking for your IP: '$ip'" }
  return $ip
}

function Test-PortFree([int]$port) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

function Wait-Port([int]$port, [int]$seconds, $proc) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { return $false }
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect("127.0.0.1", $port); $c.Close(); return $true
    } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

function Read-Passphrase {
  if ($NoPassphrase -or $env:OCI_CLI_PASSPHRASE) { return }
  $secure = Read-Host -Prompt "Passphrase of the OCI API key (hidden)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:OCI_CLI_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Save-Config {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  (@{ bastionId = $BastionId; targetIp = $TargetIp } | ConvertTo-Json) | Set-Content -Path $stateFile -Encoding ASCII
}

# ---------------------------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------------------------
function Get-Bastion {
  $b = Invoke-OciJson @("bastion", "bastion", "get", "--bastion-id", $BastionId) "Reading the bastion" `
    "Missing policy: Allow group <group> to use bastion in compartment smartops"
  return $b.data
}

function Set-Allowlist([string]$cidr) {
  $file = Join-Path $script:tempDir "cidr.json"
  (ConvertTo-Json -InputObject @($cidr) -Compress) | Set-Content -Path $file -Encoding ASCII
  $uri = "file://" + ($file -replace "\\", "/")
  $null = Invoke-OciJson @("bastion", "bastion", "update", "--bastion-id", $BastionId, "--client-cidr-list", $uri, "--force") `
    "Updating the allowlist" `
    "Missing policy: Allow group <group> to manage bastion in compartment smartops where request.operation = 'UpdateBastion'"
  for ($i = 0; $i -lt 30; $i++) {
    $b = Get-Bastion
    $list = @($b.'client-cidr-block-allow-list')
    if ($b.'lifecycle-state' -eq "ACTIVE" -and $list.Count -eq 1 -and $list[0] -eq $cidr) { return }
    Start-Sleep -Seconds 2
  }
  Fail "The bastion did not apply the new allowlist within 60 s" "Check it in the Console (Bastion > allowlist)."
}

function New-Session([string]$pubKeyFile) {
  $name = "smartops-ssh-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  $s = Invoke-OciJson @("bastion", "session", "create-port-forwarding", "--bastion-id", $BastionId,
    "--target-private-ip", $TargetIp, "--target-port", "22", "--ssh-public-key-file", $pubKeyFile,
    "--session-ttl", "$SessionTtlSeconds", "--display-name", $name) "Creating the session" `
    "Missing policy: manage bastion-session (and, if the CLI says so, read instances / subnets / vcns / vnics) in compartment smartops"
  $script:sessionId = $s.data.id
  for ($i = 0; $i -lt 60; $i++) {
    $g = Invoke-OciJson @("bastion", "session", "get", "--session-id", $script:sessionId) "Reading the session"
    if ($g.data.'lifecycle-state' -eq "ACTIVE") { return $g.data }
    if ($g.data.'lifecycle-state' -in @("FAILED", "DELETED")) { Fail "The session ended up $($g.data.'lifecycle-state')" }
    Start-Sleep -Seconds 3
  }
  Fail "The session was not ACTIVE after 180 s"
}

function Remove-Session {
  if (-not $script:sessionId) { return }
  $r = Invoke-Oci @("bastion", "session", "delete", "--session-id", $script:sessionId, "--force")
  if ($r.Code -eq 0) { Say "session deleted" } else { Say "could not delete the session (it expires by itself): $(Get-OciError $r.Text)" }
  $script:sessionId = ""
}

function New-EphemeralKey {
  $key = Join-Path $script:tempDir "session_key"
  & $SshKeygenCommand -q -t ed25519 -N '""' -C "smartops-bastion-session" -f $key | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$key.pub")) { Fail "ssh-keygen failed" }
  # OpenSSH on Windows refuses a private key other users can read.
  # Full control for you only (read-only would make the key impossible to delete afterwards).
  & icacls.exe $key /inheritance:r /grant:r "$($env:USERNAME):(F)" 2>&1 | Out-Null
  return $key
}

function Start-Tunnel([string]$key, [string]$sessionHost, [string]$user, [int]$port) {
  $err = Join-Path $script:tempDir "tunnel.err"
  $sshArgs = @("-4", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4", "-o", "StrictHostKeyChecking=accept-new", "-o", "IdentitiesOnly=yes",
    "-i", ('"' + $key + '"'), "-L", ("{0}:{1}:22" -f $port, $TargetIp), "-p", "22", ("{0}@{1}" -f $user, $sessionHost))
  $script:tunnel = Start-Process -FilePath $SshCommand -ArgumentList ($sshArgs -join " ") -PassThru `
    -WindowStyle Hidden -RedirectStandardError $err
  if (-not (Wait-Port $port 30 $script:tunnel)) {
    $tail = ""
    if (Test-Path $err) { $tail = (Get-Content $err -Tail 3) -join " | " }
    Fail "The tunnel did not come up ($tail)" "Is your IP in the allowlist? Run again, or see the runbook (section 9)."
  }
}

function Stop-Tunnel {
  if ($script:tunnel -and -not $script:tunnel.HasExited) {
    # The whole tree: a wrapper (or a future ssh helper) must not outlive the session.
    & taskkill.exe /PID $script:tunnel.Id /T /F 2>&1 | Out-Null
    Say "tunnel closed"
  }
}

function Invoke-Probe {
  Say "PROBE: which permission does this user lack? (nothing is changed)"
  $ok = $true
  $steps = @(
    @{ Name = "read the bastion (GetBastion)"; Fix = "use bastion"; Run = { $null = Get-Bastion } },
    @{ Name = "update the allowlist with its current value (UpdateBastion)"; Fix = "manage bastion where request.operation = 'UpdateBastion'"; Run = {
        $b = Get-Bastion
        $current = @($b.'client-cidr-block-allow-list')
        if ($current.Count -ne 1) { Fail "The probe needs exactly one CIDR in the allowlist (run the tool normally once first)" }
        Set-Allowlist $current[0] } },
    @{ Name = "create, read and delete a port forwarding session"; Fix = "manage bastion-session (+ reads the CLI asks for)"; Run = {
        $key = New-EphemeralKey
        $null = New-Session "$key.pub"
        Remove-Session } }
  )
  foreach ($step in $steps) {
    try { & $step.Run; Say ("PASS  " + $step.Name) }
    catch { $ok = $false; Say ("FAIL  " + $step.Name + "   -> policy to add: " + $step.Fix) }
  }
  if ($ok) { Say "PROBE PASSED: the policy is enough." } else { Say "PROBE FAILED: add what the FAIL lines say, then run it again." }
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
try {
  if (-not $BastionId -and (Test-Path $stateFile)) {
    $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
    $BastionId = $saved.bastionId
    if ($saved.targetIp -and $TargetIp -eq "10.0.0.21") { $TargetIp = $saved.targetIp }
  }
  if (-not $BastionId) { Fail "Bastion OCID needed once: -BastionId ocid1.bastion..." }
  if (-not (Get-Command $OciCommand -ErrorAction SilentlyContinue)) { Fail "The OCI CLI ('$OciCommand') is not in the PATH" }
  if (-not (Get-Command $SshCommand -ErrorAction SilentlyContinue)) { Fail "ssh is not in the PATH (Windows optional feature: OpenSSH Client)" }
  if (-not $DryRun -and -not $Probe -and -not (Test-Path $IdentityFile)) { Fail "SSH key for the VM not found: $IdentityFile" "Use -IdentityFile <path>" }

  $region = Get-RegionFromConfig
  $myIp = Get-PublicIpv4
  $cidr = "$myIp/32"
  Say "region $region, your public IP $myIp"
  $script:tempDir = Join-Path ([IO.Path]::GetTempPath()) ("smartops-bastion-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $script:tempDir | Out-Null

  Read-Passphrase
  $b = Get-Bastion
  if ($b.'lifecycle-state' -ne "ACTIVE") { Fail "The bastion is $($b.'lifecycle-state'), not ACTIVE" }
  $list = @($b.'client-cidr-block-allow-list')
  $inList = ($list.Count -eq 1 -and $list[0] -eq $cidr)

  if ($Probe) { Invoke-Probe; return }

  if ($DryRun) {
    Say ("DRY RUN: allowlist is {0}; " -f ($list -join ", ") + $(if ($inList) { "no change needed" } else { "would set it to $cidr" }))
    Say "DRY RUN: would create a port forwarding session to ${TargetIp}:22 (TTL $SessionTtlSeconds s) and open localhost:$LocalPort"
    return
  }

  if (-not $inList) {
    Say "allowlist is [$($list -join ', ')]: setting it to $cidr"
    Set-Allowlist $cidr
  } else { Say "allowlist already is $cidr" }
  Save-Config

  $port = $LocalPort
  while (-not (Test-PortFree $port)) { $port += 1; if ($port -gt $LocalPort + 20) { Fail "No free local port near $LocalPort" } }
  $key = New-EphemeralKey
  Say "creating the session (ephemeral key, TTL $SessionTtlSeconds s)"
  $session = New-Session "$key.pub"
  $sessionHost = "host.bastion.$region.oci.oraclecloud.com"
  Start-Tunnel $key $sessionHost $script:sessionId $port
  Say "tunnel up: localhost:$port -> ${TargetIp}:22"

  $sshOpts = @("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", "-o", "HostKeyAlias=smartops-demo-vm",
    "-o", "StrictHostKeyChecking=accept-new", "-i", $IdentityFile, "-p", "$port")
  if ($TunnelOnly) {
    Say ("ssh  : ssh " + ($sshOpts -join " ") + " $VmUser@localhost")
    Say ("scp  : scp " + ($sshOpts -join " ").Replace("-p $port", "-P $port") + " <file> ${VmUser}@localhost:/tmp/")
    [void](Read-Host "Press Enter to close the tunnel and delete the session")
  } else {
    & $SshCommand @sshOpts "$VmUser@localhost"
  }
} catch {
  if ($_.Exception.Message -ne "bastion-connect stopped") { Write-Host ("[bastion] ERROR: " + $_.Exception.Message) -ForegroundColor Red }
  $global:LASTEXITCODE = 1
} finally {
  Stop-Tunnel
  if (-not $Probe -and -not $DryRun) { Remove-Session }
  if ($script:tempDir -and (Test-Path $script:tempDir)) {
    Remove-Item -Recurse -Force $script:tempDir -ErrorAction SilentlyContinue
    if (Test-Path $script:tempDir) {
      Write-Host ("[bastion] WARNING: could not delete the ephemeral key directory: " + $script:tempDir + " - delete it by hand") -ForegroundColor Yellow
    }
  }
  if (-not $NoPassphrase) { Remove-Item Env:\OCI_CLI_PASSPHRASE -ErrorAction SilentlyContinue }
}
