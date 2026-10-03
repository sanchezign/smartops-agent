<#
.SYNOPSIS
  Tests of scripts/oci/setup-backup-bucket.ps1 against a FAKE oci with state (no network, no Oracle
  account, no ~/.oci). Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File scripts\oci\tests\setup-backup-bucket.tests.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$script = (Resolve-Path (Join-Path $PSScriptRoot "..\setup-backup-bucket.ps1")).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("backup-setup-tests-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$failures = 0
$runNo = 0
function Check([bool]$ok, [string]$message) {
  if ($ok) { Write-Host "ok   $message" } else { Write-Host "FAIL $message" -ForegroundColor Red; $script:failures += 1 }
}

$VM = "ocid1.instance.oc1.sa-saopaulo-1.aaaafakevm"
$COMP = "ocid1.compartment.oc1..aaaafakecomp"

# --- a fake oci that keeps its state in files ------------------------------------------------------
@'
$a = $args
$d = $env:FAKE_DIR
$op = ($a | Where-Object { $_ -notmatch '^--' } | Select-Object -First 3) -join " "
Add-Content (Join-Path $d "calls.log") ("oci " + $op)
function Arg([string]$name) { $i = [array]::IndexOf($a, $name); if ($i -ge 0) { return $a[$i + 1] } else { return "" } }
function FileArg([string]$name) { $v = Arg $name; return (Get-Content ($v -replace "^file://", "") -Raw) }
function Out($o) { ConvertTo-Json -InputObject $o -Compress -Depth 8 }
switch ($op) {
  "os ns get" { Out @{ data = "fakens" } }
  "iam dynamic-group list" {
    $f = Join-Path $d "dg.json"
    if (Test-Path $f) { Out @{ data = @((Get-Content $f -Raw | ConvertFrom-Json)) } } else { Out @{ data = @() } }
  }
  "iam dynamic-group create" {
    Set-Content (Join-Path $d "dg.json") (Out @{ id = "ocid1.dynamicgroup.fake"; name = (Arg "--name"); "matching-rule" = (Arg "--matching-rule") })
    Out @{ data = @{ id = "ocid1.dynamicgroup.fake" } }
  }
  "iam dynamic-group update" {
    $o = Get-Content (Join-Path $d "dg.json") -Raw | ConvertFrom-Json; $o.'matching-rule' = (Arg "--matching-rule")
    Set-Content (Join-Path $d "dg.json") (Out $o); Out @{ data = @{} }
  }
  "os bucket get" {
    $f = Join-Path $d "bucket.json"
    if (Test-Path $f) { Out @{ data = (Get-Content $f -Raw | ConvertFrom-Json) } } else { Write-Output '{"code": "BucketNotFound", "message": "no"}'; exit 1 }
  }
  "os bucket create" {
    Set-Content (Join-Path $d "bucket.json") (Out @{ name = (Arg "--name"); "public-access-type" = (Arg "--public-access-type"); versioning = (Arg "--versioning"); "storage-tier" = (Arg "--storage-tier") })
    Add-Content (Join-Path $d "calls.log") ("   bucket create: " + (Arg "--public-access-type") + " " + (Arg "--storage-tier") + " versioning=" + (Arg "--versioning"))
    Out @{ data = @{} }
  }
  "iam policy list" {
    $f = Join-Path $d "policy.json"
    if (Test-Path $f) { Out @{ data = @((Get-Content $f -Raw | ConvertFrom-Json)) } } else { Out @{ data = @() } }
  }
  { $_ -in "iam policy create", "iam policy update" } {
    $st = FileArg "--statements" | ConvertFrom-Json
    Set-Content (Join-Path $d "policy.json") (Out @{ id = "ocid1.policy.fake"; name = "smartops-backups"; statements = @($st) })
    Out @{ data = @{} }
  }
  "os object-lifecycle-policy get" {
    $f = Join-Path $d "lifecycle.json"
    if (Test-Path $f) { Out @{ data = @{ items = @((Get-Content $f -Raw | ConvertFrom-Json)) } } } else { Write-Output '{"code": "NotFound", "message": "no"}'; exit 1 }
  }
  "os object-lifecycle-policy put" {
    Set-Content (Join-Path $d "lifecycle.json") (FileArg "--items"); Out @{ data = @{} }
  }
  default { Write-Output "unknown op: $op"; exit 2 }
}
exit 0
'@ | Set-Content -Path (Join-Path $work "fake-oci.ps1") -Encoding ASCII
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-oci.ps1`" %*" | Set-Content -Path (Join-Path $work "oci.cmd") -Encoding ASCII

function Run-Tool([string[]]$extra, [string]$stdin = "", [switch]$keepState) {
  if (-not $keepState) {
    foreach ($f in "dg.json", "bucket.json", "policy.json", "lifecycle.json") { Remove-Item (Join-Path $work $f) -ErrorAction SilentlyContinue }
  }
  Remove-Item (Join-Path $work "calls.log") -ErrorAction SilentlyContinue
  $env:FAKE_DIR = $work
  $script:runNo += 1
  $inFile = Join-Path $work "stdin$($script:runNo).txt"; Set-Content $inFile $stdin
  $outFile = Join-Path $work "out$($script:runNo).txt"; $errFile = Join-Path $work "err$($script:runNo).txt"
  $args2 = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-CompartmentId", $COMP, "-InstanceId", $VM,
    "-OciCommand", (Join-Path $work "oci.cmd"), "-TenancyId", "ocid1.tenancy.oc1..aaaafaketen", "-Region", "sa-saopaulo-1") + $extra
  $quoted = ($args2 | ForEach-Object { if ($_ -match "\s") { '"' + $_ + '"' } else { $_ } }) -join " "
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList $quoted -PassThru -WindowStyle Hidden `
    -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $timedOut = -not $p.WaitForExit(90000)
  if ($timedOut) { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null }
  $out = (Get-Content $outFile -Raw) + (Get-Content $errFile -Raw)
  if ($timedOut) { $out += "TIMED OUT" }
  $calls = if (Test-Path (Join-Path $work "calls.log")) { Get-Content (Join-Path $work "calls.log") -Raw } else { "" }
  return @{ Out = $out; Calls = $calls }
}
$mutating = "dynamic-group create|dynamic-group update|bucket create|policy create|policy update|lifecycle-policy put"

# 1) dry run: prints the plan, changes nothing
$r = Run-Tool @("-DryRun")
Check ($r.Calls -notmatch $mutating) "dry run makes no change"
Check ($r.Out -match "DRY RUN: nothing was changed") "dry run says so"
Check ($r.Out -match "to read buckets in compartment smartops where target.bucket.name = 'smartops-backups'") "the plan shows the bucket-metadata statement"

# 2) first apply: everything is created
$r = Run-Tool @("-Yes")
foreach ($what in "dynamic-group create", "bucket create", "policy create", "lifecycle-policy put") {
  Check ($r.Calls -match $what) "first run: $what"
}
Check ($r.Calls -match "bucket create: NoPublicAccess Standard versioning=Disabled") "the bucket is private, Standard, without versioning"
$dg = Get-Content (Join-Path $work "dg.json") -Raw | ConvertFrom-Json
Check ($dg.'matching-rule' -eq "instance.id = '$VM'") "the dynamic group is exactly this VM"
$pol = Get-Content (Join-Path $work "policy.json") -Raw | ConvertFrom-Json
$vmStatements = @($pol.statements | Where-Object { $_ -like "Allow dynamic-group*" })
Check ($vmStatements.Count -eq 2) "the VM gets exactly two statements"
Check (-not ($vmStatements -join " " -match "OBJECT_DELETE|OBJECT_OVERWRITE|OBJECT_READ|OBJECT_VERSION_DELETE")) "the VM can neither delete, overwrite nor read objects"
Check (@($vmStatements | Where-Object { $_ -match "manage objects" -and $_ -match "target.bucket.name = 'smartops-backups'" -and $_ -match "OBJECT_CREATE" -and $_ -match "OBJECT_INSPECT" }).Count -eq 1) "its object statement is limited to ONE bucket and to create + inspect"
Check (@($pol.statements | Where-Object { $_ -match "^Allow service objectstorage-sa-saopaulo-1 to manage object-family" -and $_ -match "OBJECT_DELETE" }).Count -eq 1) "the Object Storage service may delete (the lifecycle rule)"
$lc = Get-Content (Join-Path $work "lifecycle.json") -Raw | ConvertFrom-Json
Check (@($lc).Count -eq 1 -and $lc.action -eq "DELETE" -and $lc.'time-amount' -eq 30 -and $lc.'time-unit' -eq "DAYS" -and $lc.target -eq "objects") "lifecycle: delete objects after 30 days"
Check ($r.Out -match "OCI_BUCKET=smartops-backups" -and $r.Out -match "OCI_NAMESPACE=fakens") "it prints the two lines for backup.env"

# 3) second run: nothing to do
$r = Run-Tool @("-Yes") -keepState
Check ($r.Calls -notmatch $mutating) "second run changes nothing (idempotent)"
Check ($r.Out -match "nothing to change") "...and says so"

# 4) the VM was replaced (new OCID): only the dynamic group's rule is updated
$vmBefore = $VM
$VM = "ocid1.instance.oc1.sa-saopaulo-1.aaaanewvm"
$r = Run-Tool @("-Yes") -keepState
Check ($r.Calls -match "dynamic-group update" -and $r.Calls -notmatch "policy update|bucket create|policy create") "a new VM OCID updates only the dynamic group"
$VM = $vmBefore

# 5) the policy was tampered with (an extra statement): it is put back
$pol = Get-Content (Join-Path $work "policy.json") -Raw | ConvertFrom-Json
$pol.statements = @($pol.statements) + @("Allow dynamic-group 'Default'/'smartops-vm' to manage object-family in tenancy")
Set-Content (Join-Path $work "policy.json") (ConvertTo-Json -InputObject $pol -Compress -Depth 8)
$r = Run-Tool @("-Yes") -keepState
Check ($r.Calls -match "policy update") "a drifted policy is corrected"
$pol = Get-Content (Join-Path $work "policy.json") -Raw | ConvertFrom-Json
Check (@($pol.statements).Count -eq 3 -and -not ($pol.statements -join " " -match "object-family in tenancy")) "...back to exactly the three statements"

# 6) a public bucket is refused
Set-Content (Join-Path $work "bucket.json") '{"name":"smartops-backups","public-access-type":"ObjectRead","versioning":"Disabled"}'
$r = Run-Tool @("-Yes") -keepState
Check ($r.Out -match "is PUBLIC") "an existing public bucket stops the tool"
Check ($r.Calls -notmatch $mutating) "...before changing anything"

# 7) answering anything but "yes" cancels
$r = Run-Tool @() "no"
Check ($r.Out -match "cancelled: nothing was changed" -and $r.Calls -notmatch $mutating) "not typing 'yes' changes nothing"

# 8) bad input
$VM = "i-123"
$r = Run-Tool @("-DryRun")
Check ($r.Out -match "must be the VM's OCID") "a wrong -InstanceId is refused"
$VM = $vmBefore

# 9) the script never writes to ~/.oci and is ASCII
$text = Get-Content $script -Raw
Check ($text -notmatch "(Set-Content|Add-Content|Out-File|Remove-Item)[^\r\n]*\.oci") "the script does not write to ~/.oci"
Check (-not ($text.ToCharArray() | Where-Object { [int]$_ -gt 127 })) "the script is ASCII only (PowerShell 5.1)"

if ($failures -eq 0) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } else { Write-Host "kept for inspection: $work" }
if ($failures -eq 0) { Write-Host "`nALL BACKUP-SETUP TESTS PASSED"; exit 0 } else { Write-Host "`n$failures FAILED"; exit 1 }
