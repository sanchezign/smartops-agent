<#
.SYNOPSIS
  Tests of scripts/oci/bastion-connect.ps1 against a FAKE oci, ssh and ssh-keygen (no network, no
  Oracle account, no ~/.oci). Run on Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File scripts\oci\tests\bastion-connect.tests.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$script = (Resolve-Path (Join-Path $PSScriptRoot "..\bastion-connect.ps1")).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("bastion-tests-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work "calls.log"
$failures = 0
$script:runNo = 0
$probePort = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $probePort.Start()
$testPort = $probePort.LocalEndpoint.Port; $probePort.Stop()
function Check([bool]$ok, [string]$message) {
  if ($ok) { Write-Host "ok   $message" } else { Write-Host "FAIL $message" -ForegroundColor Red; $script:failures += 1 }
}

# --- fakes -------------------------------------------------------------------------------------
@'
param()
$a = $args
$calls = $env:FAKE_LOG
$op = ($a | Where-Object { $_ -notmatch '^--' } | Select-Object -First 3) -join " "
$pp = if ($env:OCI_CLI_PASSPHRASE) { "pp" } else { "nopp" }
Add-Content $calls ("oci " + $op + " [" + $pp + "]")
foreach ($d in ($env:FAKE_DENY -split ",")) { if ($d -and $op -like "*$d*") {
  '{"code": "NotAuthorizedOrNotFound", "message": "denied"}' | Write-Output; exit 1 } }
$stateFile = Join-Path $env:FAKE_DIR "allow.txt"
if (-not (Test-Path $stateFile)) { Set-Content $stateFile $env:FAKE_ALLOWLIST }
if ($op -eq "bastion bastion get") {
  $list = (Get-Content $stateFile -Raw).Trim()
  '{"data":{"id":"ocid1.bastion.x","lifecycle-state":"ACTIVE","client-cidr-block-allow-list":["' + $list + '"]}}'
} elseif ($op -eq "bastion bastion update") {
  $i = [array]::IndexOf($a, "--client-cidr-list"); $uri = $a[$i + 1] -replace "^file://", ""
  $v = (Get-Content $uri -Raw | ConvertFrom-Json); Set-Content $stateFile ($v -join ",")
  Add-Content $calls ("   allowlist set to " + ($v -join ","))
  '{"data":{}}'
} elseif ($op -eq "bastion session create-port-forwarding") {
  $i = [array]::IndexOf($a, "--ssh-public-key-file"); Add-Content $calls ("   pubkey exists: " + (Test-Path $a[$i + 1]))
  '{"data":{"id":"ocid1.bastionsession.oc1.sa-saopaulo-1.fake","lifecycle-state":"CREATING"}}'
} elseif ($op -eq "bastion session get") {
  '{"data":{"id":"ocid1.bastionsession.oc1.sa-saopaulo-1.fake","lifecycle-state":"ACTIVE"}}'
} elseif ($op -eq "bastion session delete") { '{"data":{}}' } else { Write-Output "unknown op"; exit 2 }
exit 0
'@ | Set-Content -Path (Join-Path $work "fake-oci.ps1") -Encoding ASCII
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-oci.ps1`" %*" | Set-Content -Path (Join-Path $work "oci.cmd") -Encoding ASCII

@'
$a = $args
Add-Content $env:FAKE_LOG ("ssh " + ($a -join " "))
if ($a -contains "-N") {
  Add-Content $env:FAKE_LOG ("   tunnel-stdin-redirected=" + [Console]::IsInputRedirected + " has-n=" + ($a -contains "-n"))
  $countFile = Join-Path $env:FAKE_DIR "ssh-count.txt"
  $n = 1 + $(if (Test-Path $countFile) { [int](Get-Content $countFile) } else { 0 })
  Set-Content $countFile $n
  if ($env:FAKE_SSH_FAIL_N -and $n -le [int]$env:FAKE_SSH_FAIL_N) {
    [Console]::Error.WriteLine($env:FAKE_SSH_FAIL_TEXT); exit 255
  }
  $l = ($a | Where-Object { $_ -match '^\d+:[\d.]+:22$' } | Select-Object -First 1)
  $port = [int]($l -split ":")[0]
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
  $listener.Start(); Start-Sleep -Seconds 120
}
exit 0
'@ | Set-Content -Path (Join-Path $work "fake-ssh.ps1") -Encoding ASCII
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-ssh.ps1`" %*" | Set-Content -Path (Join-Path $work "ssh.cmd") -Encoding ASCII

@'
$a = $args
$f = $a[[array]::IndexOf($a, "-f") + 1]
Set-Content $f "PRIVATE"; Set-Content ($f + ".pub") "ssh-ed25519 AAAA"
exit 0
'@ | Set-Content -Path (Join-Path $work "fake-keygen.ps1") -Encoding ASCII
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-keygen.ps1`" %*" | Set-Content -Path (Join-Path $work "ssh-keygen.cmd") -Encoding ASCII
Set-Content (Join-Path $work "id_vm") "KEY"

# --- runner: a clean child process per scenario --------------------------------------------------
function Run-Tool([string]$allowlist, [string]$deny, [string[]]$extra, [switch]$feedEnter, [int]$sshFailN = 0, [string]$sshFailText = "") {
  Remove-Item $log -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $work "ssh-count.txt") -ErrorAction SilentlyContinue
  $env:FAKE_SSH_FAIL_N = "$sshFailN"; $env:FAKE_SSH_FAIL_TEXT = $sshFailText
  Remove-Item (Join-Path $work "allow.txt") -ErrorAction SilentlyContinue
  $env:FAKE_LOG = $log; $env:FAKE_DIR = $work; $env:FAKE_ALLOWLIST = $allowlist; $env:FAKE_DENY = $deny
  $env:OCI_CLI_PASSPHRASE = "secret-passphrase"
  $env:LOCALAPPDATA = $work   # the tool's state file goes to the temp dir, never to the real profile
  $args2 = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-BastionId", "ocid1.bastion.x",
    "-OciCommand", (Join-Path $work "oci.cmd"), "-SshCommand", (Join-Path $work "ssh.cmd"),
    "-SshKeygenCommand", (Join-Path $work "ssh-keygen.cmd"), "-PublicIp", "203.0.113.7", "-Region", "sa-saopaulo-1",
    "-IdentityFile", (Join-Path $work "id_vm"), "-LocalPort", "$testPort") + $extra
  if ($feedEnter) {
    # -TunnelOnly waits for Enter: stdin comes from a file with one empty line; a hung run is killed.
    $script:runNo += 1
    $inFile = Join-Path $work "stdin$($script:runNo).txt"; "`r`n" | Set-Content $inFile
    $outFile = Join-Path $work "out$($script:runNo).txt"; $errFile = Join-Path $work "err$($script:runNo).txt"
    $quoted = ($args2 | ForEach-Object { if ($_ -match "s") { '"' + $_ + '"' } else { $_ } }) -join " "
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $quoted -PassThru -WindowStyle Hidden `
      -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $timedOut = -not $p.WaitForExit(90000)
    if ($timedOut) { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null }
    $out = (Get-Content $outFile -Raw) + (Get-Content $errFile -Raw)
    if ($timedOut) { $out += "TIMED OUT" }
    $code = $(if ($timedOut) { -1 } else { $p.ExitCode })
  } else {
    $out = & powershell.exe @args2 2>&1 | Out-String
    $code = $LASTEXITCODE
  }
  $calls = if (Test-Path $log) { Get-Content $log -Raw } else { "" }
  return @{ Out = $out; Calls = $calls; Code = $code }
}

$tmp = [IO.Path]::GetTempPath()
$dirsBefore = @(Get-ChildItem $tmp -Directory -Filter "smartops-bastion-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
# 1) the IP changed: allowlist updated, session created, tunnel + ssh, session deleted
$r = Run-Tool "198.51.100.1/32" "" @()
Check ($r.Calls -match "allowlist set to 203\.0\.113\.7/32") "changed IP -> the allowlist becomes <ip>/32"
Check ($r.Calls -match "pubkey exists: True") "the session is created with an ephemeral public key that exists"
Check ($r.Calls -match "ssh -4 -n -N .*-L ${testPort}:10\.0\.0\.21:22 .*ocid1\.bastionsession\.oc1\.sa-saopaulo-1\.fake@host\.bastion\.sa-saopaulo-1\.oci\.oraclecloud\.com") "the tunnel goes to the VM's private IP through the session host"
Check ($r.Calls -match "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o HostKeyAlias=smartops-demo-vm .*-p ${testPort} ubuntu@localhost") "the interactive ssh keeps the connection alive"
Check ($r.Calls -match "bastion session delete") "the session is deleted at the end"
Check ($r.Calls -notmatch "secret-passphrase") "the passphrase never reaches a command line"
Check (([regex]::Matches($r.Calls, "\[pp\]")).Count -ge 4) "every oci call received the passphrase through the environment"
Check ($r.Out -notmatch "secret-passphrase") "the passphrase is not printed"
$dirsAfter = @(Get-ChildItem $tmp -Directory -Filter "smartops-bastion-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Where-Object { $dirsBefore -notcontains $_ })
Check ($dirsAfter.Count -eq 0) "the ephemeral key directory is removed"
Check (Test-Path (Join-Path $work "smartops\bastion.json")) "the bastion OCID is saved for next time"

# 2) the IP is already there: no update call
$r = Run-Tool "203.0.113.7/32" "" @()
Check ($r.Calls -notmatch "bastion bastion update") "allowlist already right -> no UpdateBastion call"
Check ($r.Calls -match "bastion session delete") "...and the session is still cleaned up"

# 3) UpdateBastion denied: stops with the policy to add, creates nothing
$r = Run-Tool "198.51.100.1/32" "bastion update" @()
Check ($r.Out -match "request\.operation = 'UpdateBastion'") "UpdateBastion denied -> the message says which policy statement to add"
Check ($r.Calls -notmatch "create-port-forwarding") "...and no session is created"

# 4) dry run changes nothing
$r = Run-Tool "198.51.100.1/32" "" @("-DryRun")
Check ($r.Out -match "would set it to 203\.0\.113\.7/32") "dry run says what it would do"
Check ($r.Calls -notmatch "update|create-port-forwarding|delete") "dry run changes nothing"

# 5) probe: reports each missing permission
$r = Run-Tool "203.0.113.7/32" "create-port-forwarding" @("-Probe")
Check ($r.Out -match "PASS  read the bastion") "probe: GetBastion passes"
Check ($r.Out -match "PASS  update the allowlist") "probe: UpdateBastion passes"
Check ($r.Out -match "FAIL  create, read and delete a port forwarding session") "probe: the denied step is reported"
Check ($r.Out -match "PROBE FAILED") "probe: overall failure"
$r = Run-Tool "203.0.113.7/32" "" @("-Probe")
Check ($r.Out -match "PROBE PASSED") "probe: passes with every permission"

# 6) tunnel-only prints scp / ssh commands and waits (stdin closed -> returns)
$r = Run-Tool "203.0.113.7/32" "" @("-TunnelOnly") -feedEnter
Check ($r.Out -match "scp  : scp .*-P ${testPort} .* ubuntu@localhost:/tmp/") "tunnel-only prints the scp command and then closes everything"
Check ($r.Calls -match "bastion session delete") "tunnel-only also deletes the session"

# 6b) the tunnel's ssh never shares the console: -n, and stdin redirected to a file
$r = Run-Tool "203.0.113.7/32" "" @()
Check ($r.Calls -match "tunnel-stdin-redirected=True has-n=True") "the tunnel's ssh has -n and its stdin redirected (it cannot steal your keystrokes)"

# 6c) the session is ACTIVE before the Bastion accepts its key: retry, then succeed
$keyText = "Warning: ocid1.bastionsession.oc1.sa-saopaulo-1.fake@host.bastion: Permission denied (publickey)."
$r = Run-Tool "203.0.113.7/32" "" @("-TunnelRetrySeconds", "1", "-TunnelWaitSeconds", "60") -sshFailN 2 -sshFailText $keyText
Check ((([regex]::Matches($r.Calls, "ssh -4 -n -N")).Count) -eq 3) "key not accepted yet: the tunnel is retried (3 attempts, the third works)"
Check ($r.Out -match "tunnel attempt 1: the session is ACTIVE but the Bastion has not accepted its key yet; retrying") "...and says why it retries"
Check ($r.Calls -match "-p ${testPort} ubuntu@localhost") "...and the interactive ssh still opens afterwards"
Check ($r.Calls -match "bastion session delete") "...and the session is deleted"

# 6d) the key never gets accepted: a clear message that it is NOT the allowlist
$r = Run-Tool "203.0.113.7/32" "" @("-TunnelRetrySeconds", "1", "-TunnelWaitSeconds", "4") -sshFailN 99 -sshFailText $keyText
Check ($r.Out -match "does not accept the session's key") "persistent Permission denied -> 'the Bastion does not accept the session key'"
Check ($r.Out -match "NOT the allowlist") "...and it says it is not the allowlist"
Check ($r.Calls -notmatch "ubuntu@localhost") "...and no interactive ssh is attempted"
Check ($r.Calls -match "bastion session delete") "...and the session is still deleted"

# 6e) network / allowlist problem: a different message
$r = Run-Tool "203.0.113.7/32" "" @("-TunnelRetrySeconds", "1", "-TunnelWaitSeconds", "4") -sshFailN 99 -sshFailText "ssh: connect to host host.bastion.sa-saopaulo-1.oci.oraclecloud.com port 22: Connection timed out"
Check ($r.Out -match "NETWORK or the allowlist") "Connection timed out -> points at the network / allowlist, not the key"
Check ($r.Out -notmatch "NOT the allowlist") "...and does not blame the key"

# 6f) -SshDebug: ssh -v and a sanitized log (no session OCID)
$r = Run-Tool "203.0.113.7/32" "" @("-SshDebug", "-TunnelRetrySeconds", "1", "-TunnelWaitSeconds", "30") -sshFailN 1 -sshFailText $keyText
$dbg = Join-Path $work "smartops\bastion-ssh-debug.log"
Check ($r.Calls -match "ssh -4 -n -N -v ") "-SshDebug adds -v to the tunnel"
Check ((Test-Path $dbg) -and ((Get-Content $dbg -Raw) -match "Permission denied") -and ((Get-Content $dbg -Raw) -match "bastionsession\.<redacted>")) "-SshDebug logs ssh's own words with the session OCID redacted"
Check ((Test-Path $dbg) -and -not ((Get-Content $dbg -Raw) -match "oc1\.sa-saopaulo-1\.fake")) "...and the OCID itself is not in the log"

# 7) the script never writes to the OCI config and is plain ASCII
$text = Get-Content $script -Raw
Check ($text -notmatch "Set-Content[^\r\n]*\.oci" -and $text -notmatch "Add-Content[^\r\n]*\.oci" -and $text -notmatch "Out-File[^\r\n]*\.oci") "the script does not write to ~/.oci"
Check (-not ($text.ToCharArray() | Where-Object { [int]$_ -gt 127 })) "the script is ASCII only (PowerShell 5.1)"

if ($failures -eq 0) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } else { Write-Host "kept for inspection: $work" }
if ($failures -eq 0) { Write-Host "`nALL BASTION-CONNECT TESTS PASSED"; exit 0 } else { Write-Host "`n$failures FAILED"; exit 1 }
