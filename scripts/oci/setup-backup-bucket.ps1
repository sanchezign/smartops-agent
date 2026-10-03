<#
.SYNOPSIS
  Creates (or checks) everything the demo's backups need in OCI Object Storage (phase 12, M5).
  Runs on YOUR PC (Windows PowerShell 5.1) with the OCI CLI and YOUR administrator profile.
  Guide: docs/deploy/backups.md

.DESCRIPTION
  Idempotent: run it again and it changes nothing that is already right.
    1. dynamic group  smartops-vm   = exactly this VM (matching rule: instance.id = '<VM OCID>')
    2. bucket         smartops-backups   private, Standard tier, no versioning
    3. policy         smartops-backups   (in the root compartment), three statements:
         - the VM may READ that one bucket's metadata (Object Storage needs it to find the bucket);
         - the VM may CREATE and INSPECT objects in that one bucket and NOTHING else: it cannot
           overwrite, delete or read a backup (a stolen VM cannot destroy or leak the backups);
         - the Object Storage SERVICE may delete objects (the lifecycle rule needs it).
    4. lifecycle rule: delete objects older than 30 days (it runs once a day).
  It only READS ~/.oci/config (tenancy and region); it never writes there.

  -DryRun prints the exact statements and commands without changing anything.
  Without -Yes it shows the plan and asks you to type "yes".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\oci\setup-backup-bucket.ps1 `
    -CompartmentId ocid1.compartment.oc1..xxxx -InstanceId ocid1.instance.oc1.sa-saopaulo-1.xxxx -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CompartmentId,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [string]$OciProfile = "DEFAULT",
  [string]$CompartmentName = "smartops",
  [string]$BucketName = "smartops-backups",
  [int]$RetentionDays = 30,
  [string]$DynamicGroupName = "smartops-vm",
  [string]$PolicyName = "smartops-backups",
  [string]$IdentityDomain = "Default",
  [switch]$DryRun,
  [switch]$Yes,
  # Testing / overrides.
  [string]$OciCommand = "oci",
  [string]$TenancyId = "",
  [string]$Region = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Say([string]$message) { Write-Host ("[backup-setup] " + $message) }
function Fail([string]$message, [string]$hint = "") {
  Write-Host ("[backup-setup] ERROR: " + $message) -ForegroundColor Red
  if ($hint) { Write-Host ("[backup-setup] " + $hint) }
  throw "setup-backup-bucket stopped"
}

if ($InstanceId -notmatch '^ocid1\.instance\.') { Fail "-InstanceId must be the VM's OCID (ocid1.instance...)" }
if ($CompartmentId -notmatch '^ocid1\.compartment\.') { Fail "-CompartmentId must be a compartment OCID (ocid1.compartment...)" }
if ($BucketName -notmatch '^[A-Za-z0-9._-]{1,256}$') { Fail "Invalid bucket name" }
if ($RetentionDays -lt 1 -or $RetentionDays -gt 365) { Fail "-RetentionDays must be between 1 and 365" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("smartops-backup-setup-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---------------------------------------------------------------------------------------------
# OCI CLI
# ---------------------------------------------------------------------------------------------
function Invoke-Oci([string[]]$CliArgs) {
  $output = & $OciCommand @CliArgs --profile $OciProfile 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Text = $output }
}
function Get-OciError([string]$text) {
  if ($text -match '"code":\s*"([A-Za-z]+)"') { return $Matches[1] }
  return ""
}
function ConvertFrom-OciText([string]$text) {
  $start = $text.IndexOf("{")
  if ($start -lt 0) { return $null }
  return ($text.Substring($start) | ConvertFrom-Json)
}
# Runs a command that must work; returns the parsed JSON (or $null for an empty answer).
function Invoke-OciJson([string[]]$CliArgs, [string]$what) {
  $r = Invoke-Oci ($CliArgs + @("--output", "json"))
  if ($r.Code -ne 0) {
    $code = Get-OciError $r.Text
    if ($code -eq "NotAuthorizedOrNotFound" -or $code -eq "NotAuthenticated") {
      Fail ("{0}: {1}" -f $what, $code) "This profile ($OciProfile) must be able to manage dynamic groups, policies and buckets (your administrator profile)."
    }
    $detail = ($r.Text -replace "\s+", " ")
    if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
    Fail ("{0} failed ({1})" -f $what, $detail)
  }
  return (ConvertFrom-OciText $r.Text)
}
function Write-JsonFile([string]$name, $value) {
  $file = Join-Path $tmp $name
  (ConvertTo-Json -InputObject $value -Compress -Depth 8) | Set-Content -Path $file -Encoding ASCII
  return "file://" + ($file -replace "\\", "/")
}

function Read-ConfigValue([string]$key) {
  $cfg = $env:OCI_CLI_CONFIG_FILE
  if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE ".oci\config" }
  if (-not (Test-Path $cfg)) { return "" }
  $inSection = $false
  foreach ($line in Get-Content $cfg) {
    if ($line -match '^\s*\[(.+)\]\s*$') { $inSection = ($Matches[1] -eq $OciProfile); continue }
    if ($inSection -and $line -match ("^\s*" + $key + "\s*=\s*(\S+)")) { return $Matches[1] }
  }
  return ""
}

# ---------------------------------------------------------------------------------------------
# The plan (pure: what will exist)
# ---------------------------------------------------------------------------------------------
function Get-Statements([string]$region) {
  $dg = "dynamic-group '$IdentityDomain'/'$DynamicGroupName'"
  $comp = "compartment $CompartmentName"
  return @(
    "Allow $dg to read buckets in $comp where target.bucket.name = '$BucketName'",
    "Allow $dg to manage objects in $comp where all {target.bucket.name = '$BucketName', any {request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_INSPECT'}}",
    "Allow service objectstorage-$region to manage object-family in $comp where any {request.permission = 'BUCKET_INSPECT', request.permission = 'BUCKET_READ', request.permission = 'OBJECT_INSPECT', request.permission = 'OBJECT_DELETE', request.permission = 'OBJECT_VERSION_DELETE'}"
  )
}
function Get-MatchingRule { return "instance.id = '$InstanceId'" }
function Get-LifecycleItems {
  return @(@{ name = "expire-backups"; action = "DELETE"; "time-amount" = $RetentionDays; "time-unit" = "DAYS"; "is-enabled" = $true; target = "objects" })
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
try {
  if (-not (Get-Command $OciCommand -ErrorAction SilentlyContinue)) { Fail "The OCI CLI ('$OciCommand') is not in the PATH" }
  if (-not $TenancyId) { $TenancyId = Read-ConfigValue "tenancy" }
  if (-not $TenancyId) { Fail "Could not find the tenancy OCID in the profile $OciProfile" "Pass it: -TenancyId ocid1.tenancy..." }
  if (-not $Region) { $Region = Read-ConfigValue "region" }
  if (-not $Region) { Fail "Could not find the region in the profile $OciProfile" "Pass it: -Region sa-saopaulo-1" }

  $namespace = ([string](Invoke-OciJson @("os", "ns", "get") "Reading the Object Storage namespace").data).Trim()
  $statements = Get-Statements $Region
  $rule = Get-MatchingRule

  Say "tenancy namespace: $namespace, region: $Region"
  Say "dynamic group '$DynamicGroupName': matching rule  $rule"
  Say "bucket '$BucketName' (private, Standard, no versioning), objects deleted after $RetentionDays days"
  Say "policy '$PolicyName' (root compartment) will hold exactly these statements:"
  foreach ($st in $statements) { Say ("  " + $st) }

  # --- what exists now
  $dgList = Invoke-OciJson @("iam", "dynamic-group", "list", "--compartment-id", $TenancyId, "--name", $DynamicGroupName, "--all") "Listing dynamic groups"
  $dgNow = $null
  if ($dgList -and $dgList.data -and @($dgList.data).Count -gt 0) { $dgNow = @($dgList.data)[0] }

  $bucketNow = $null
  $b = Invoke-Oci @("os", "bucket", "get", "--namespace-name", $namespace, "--bucket-name", $BucketName, "--output", "json")
  if ($b.Code -eq 0) { $bucketNow = (ConvertFrom-OciText $b.Text).data }
  elseif ((Get-OciError $b.Text) -ne "BucketNotFound") { Fail "Reading the bucket failed ($(Get-OciError $b.Text))" }

  $polList = Invoke-OciJson @("iam", "policy", "list", "--compartment-id", $TenancyId, "--name", $PolicyName, "--all") "Listing policies"
  $polNow = $null
  if ($polList -and $polList.data -and @($polList.data).Count -gt 0) { $polNow = @($polList.data)[0] }

  $lcNow = $null
  $lc = Invoke-Oci @("os", "object-lifecycle-policy", "get", "--namespace-name", $namespace, "--bucket-name", $BucketName, "--output", "json")
  if ($lc.Code -eq 0) { $lcNow = (ConvertFrom-OciText $lc.Text).data }

  # --- decide
  $todo = @()
  if (-not $dgNow) { $todo += "create the dynamic group" }
  elseif ($dgNow.'matching-rule' -ne $rule) { $todo += "update the dynamic group's matching rule" }
  if (-not $bucketNow) { $todo += "create the bucket" }
  else {
    if ($bucketNow.'public-access-type' -ne "NoPublicAccess") { Fail "The bucket '$BucketName' exists and is PUBLIC ($($bucketNow.'public-access-type'))" "Make it private in the Console, then run again." }
    if ($bucketNow.versioning -and $bucketNow.versioning -ne "Disabled") { Say "WARNING: the bucket has versioning '$($bucketNow.versioning)' (this tool creates it without)" }
  }
  $same = $false
  if ($polNow) {
    $have = @($polNow.statements | Sort-Object)
    $want = @($statements | Sort-Object)
    $same = (($have -join "`n") -eq ($want -join "`n"))
  }
  if (-not $polNow) { $todo += "create the policy" } elseif (-not $same) { $todo += "update the policy's statements" }
  $wantLc = Get-LifecycleItems | ForEach-Object { $_ }
  $lcSame = $false
  if ($lcNow -and $lcNow.items) {
    $i = @($lcNow.items)
    $lcSame = ($i.Count -eq 1 -and $i[0].action -eq "DELETE" -and [int]$i[0].'time-amount' -eq $RetentionDays -and $i[0].'time-unit' -eq "DAYS" -and $i[0].'is-enabled' -eq $true -and $i[0].target -eq "objects")
  }
  if (-not $lcSame) { $todo += "set the lifecycle rule ($RetentionDays days)" }

  if ($todo.Count -eq 0) {
    Say "everything is already as planned: nothing to change."
  } else {
    foreach ($t in $todo) { Say ("to do: " + $t) }
    if ($DryRun) { Say "DRY RUN: nothing was changed."; return }
    if (-not $Yes) {
      $answer = Read-Host "Type yes to apply these changes"
      if ($answer -ne "yes") { Say "cancelled: nothing was changed."; return }
    }

    if (-not $dgNow) {
      $null = Invoke-OciJson @("iam", "dynamic-group", "create", "--compartment-id", $TenancyId, "--name", $DynamicGroupName,
        "--description", "SmartOps demo VM (instance principal for backups)", "--matching-rule", $rule) "Creating the dynamic group"
      Say "dynamic group created"
    } elseif ($dgNow.'matching-rule' -ne $rule) {
      $null = Invoke-OciJson @("iam", "dynamic-group", "update", "--dynamic-group-id", $dgNow.id, "--matching-rule", $rule, "--force") "Updating the dynamic group"
      Say "dynamic group updated"
    }
    if (-not $bucketNow) {
      $null = Invoke-OciJson @("os", "bucket", "create", "--compartment-id", $CompartmentId, "--namespace-name", $namespace, "--name", $BucketName,
        "--public-access-type", "NoPublicAccess", "--storage-tier", "Standard", "--versioning", "Disabled") "Creating the bucket"
      Say "bucket created"
    }
    $stFile = Write-JsonFile "statements.json" @($statements)
    if (-not $polNow) {
      $null = Invoke-OciJson @("iam", "policy", "create", "--compartment-id", $TenancyId, "--name", $PolicyName,
        "--description", "SmartOps demo: append-only backups to one bucket", "--statements", $stFile) "Creating the policy"
      Say "policy created"
    } elseif (-not $same) {
      $null = Invoke-OciJson @("iam", "policy", "update", "--policy-id", $polNow.id, "--statements", $stFile, "--force") "Updating the policy"
      Say "policy updated"
    }
    if (-not $lcSame) {
      $lcFile = Write-JsonFile "lifecycle.json" @(Get-LifecycleItems)
      $null = Invoke-OciJson @("os", "object-lifecycle-policy", "put", "--namespace-name", $namespace, "--bucket-name", $BucketName,
        "--items", $lcFile, "--force") "Setting the lifecycle rule"
      Say "lifecycle rule set"
    }
  }

  Say ""
  Say "Put these two lines in /etc/smartops/backup.env on the VM:"
  Say "  OCI_BUCKET=$BucketName"
  Say "  OCI_NAMESPACE=$namespace"
  Say "Oracle says a change to a dynamic group's matching rule can take about an hour to apply: if the"
  Say "first upload from the VM is refused, wait and try again before changing anything."
} catch {
  if ($_.Exception.Message -ne "setup-backup-bucket stopped") { Write-Host ("[backup-setup] ERROR: " + $_.Exception.Message) -ForegroundColor Red }
  $global:LASTEXITCODE = 1
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
