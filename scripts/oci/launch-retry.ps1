<#
.SYNOPSIS
  Reintenta crear la VM de la demo (smartops-demo) en Oracle Cloud hasta que haya capacidad A1.
  Fase 12, M1. Corre en TU PC (Windows 11, PowerShell 5.1) con OCI CLI y el usuario de minimo
  privilegio smartops-launcher. Guia: docs/deploy/m1-retry-launch.md

.DESCRIPTION
  - Antes de CADA intento verifica que no exista ya una instancia "smartops-demo" (en cualquier
    estado salvo TERMINATED/TERMINATING) en el compartimento: nunca crea mas de una.
  - Lanza la instancia directo (oci compute instance launch --no-retry), no un job del stack de
    Resource Manager (ver la guia: errores claros, sin estado de Terraform a medias).
  - "Out of host capacity" -> espera 5-10 min (al azar) y reintenta. 429 TooManyRequests -> 15 min.
  - Cualquier otro error (autenticacion, permisos, limites, parametros) -> se FRENA y lo explica.
  - Al lograrlo: se detiene, notificacion de Windows + sonido.
  - Log local sin secretos: %LOCALAPPDATA%\smartops\launch-retry.log
  - Mientras corre, evita que Windows suspenda la PC (se libera al terminar).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\oci\launch-retry.ps1 `
    -CompartmentId ocid1.compartment.oc1..xxxx -OciProfile SMARTOPS -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CompartmentId,
  [string]$OciProfile = "SMARTOPS",
  [string]$DisplayName = "smartops-demo",
  [string]$SubnetName = "smartops-public",
  [string]$AvailabilityDomain = "",
  [string]$ImageId = "",
  [string]$SshPublicKeyPath = (Join-Path $env:USERPROFILE ".ssh\smartops_oci.pub"),
  [int]$MinWaitSeconds = 300,
  [int]$MaxWaitSeconds = 600,
  [double]$MaxDays = 5,
  [switch]$DryRun,
  # Sin notificacion ni sonido (solo para probar el script con un oci falso).
  [switch]$NoAlert
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# Configuracion APROBADA (no se cambia por parametro): A1.Flex 1 OCPU / 3 GB, Ubuntu 24.04 ARM,
# subred smartops-public, SIN IP publica (despues se asigna la reservada a mano).
$Shape = "VM.Standard.A1.Flex"
$Ocpus = 1
$MemoryGb = 3

$logDir = Join-Path $env:LOCALAPPDATA "smartops"
$logFile = Join-Path $logDir "launch-retry.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$level, [string]$message) {
  $line = "{0}  {1,-8} {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $level, $message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

# --- Keep the PC awake while this script runs (released on exit) ---------------------------
if (-not ('SmartOps.Power' -as [type])) {
Add-Type -Namespace SmartOps -Name Power -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@
}
$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"

# --- Windows notification + sound ------------------------------------------------------------
function Show-Alert([string]$title, [string]$text) {
  if ($NoAlert) { Write-Log "ALERT" "$title - $text"; return }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $safeTitle = [System.Security.SecurityElement]::Escape($title)
    $safeText = [System.Security.SecurityElement]::Escape($text)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeText</text></binding></visual><audio src='ms-winsoundevent:Notification.Looping.Alarm' loop='false'/><actions><action content='OK' arguments='ok' activationType='foreground'/></actions></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  } catch {
    Write-Log "WARN" "no se pudo mostrar la notificacion de Windows: $($_.Exception.Message)"
  }
  try {
    for ($i = 0; $i -lt 3; $i++) { [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 700 }
    [Console]::Beep(880, 400); [Console]::Beep(988, 400); [Console]::Beep(1175, 600)
  } catch { }
}

# --- OCI CLI wrapper: exit code, stdout and stderr, never via the console encoding games -----
$ociExe = (Get-Command oci -ErrorAction SilentlyContinue)
if (-not $ociExe) { throw "No encuentro 'oci' en el PATH. Instala OCI CLI (ver la guia) y abri una consola nueva." }
$ociPath = $ociExe.Source

function Invoke-Oci([string[]]$ociArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ociPath
  $quoted = @()
  foreach ($a in (@("--profile", $OciProfile) + $ociArgs)) {
    if ($a -match '[\s"]') { $quoted += '"' + ($a -replace '"', '\"') + '"' } else { $quoted += $a }
  }
  $psi.Arguments = ($quoted -join " ")
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return [pscustomobject]@{ ExitCode = $proc.ExitCode; Stdout = $stdoutTask.Result; Stderr = $stderr }
}

# Classifies an OCI CLI failure. The ServiceError text carries "code" and "status".
function Get-OciFailure([string]$stderr) {
  $code = ""; $status = ""; $message = ""
  if ($stderr -match '"code"\s*:\s*"([^"]+)"') { $code = $Matches[1] }
  if ($stderr -match '"status"\s*:\s*(\d+)') { $status = $Matches[1] }
  if ($stderr -match '"message"\s*:\s*"([^"]*)"') { $message = $Matches[1] }
  if (-not $message) { $message = [string]($stderr -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1) }
  if (-not $message) { $message = "(sin mensaje)" }
  if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
  $kind = "fatal"
  if ($message -match 'Out of host capacity' -or $message -match 'out of capacity') { $kind = "capacity" }
  elseif ($code -eq "TooManyRequests" -or $status -eq "429") { $kind = "throttled" }
  elseif ($status -match '^5\d\d$' -and $code -ne "InternalError") { $kind = "transient" }
  return [pscustomobject]@{ Kind = $kind; Code = $code; Status = $status; Message = $message }
}

function Stop-Fatal([string]$what, $failure) {
  Write-Log "STOP" "$what -> $($failure.Status) $($failure.Code): $($failure.Message)"
  switch -Regex ($failure.Code) {
    '^NotAuthenticated$' { Write-Log "HINT" "Autenticacion: revisa ~/.oci/config (perfil $OciProfile), el fingerprint y la ruta de la clave." }
    '^NotAuthorizedOrNotFound$' { Write-Log "HINT" "Permisos: revisa la politica del grupo smartops-launchers o el OCID del compartimento." }
    'LimitExceeded|QuotaExceeded' { Write-Log "HINT" "Limite/cuota: puede que ya exista otra instancia A1 en la cuenta (Limits, Quotas and Usage)." }
    '^InvalidParameter$' { Write-Log "HINT" "Parametro invalido: revisa la imagen, la subred o el dominio de disponibilidad." }
  }
  Show-Alert "SmartOps: el reintento se freno" "$($failure.Code): $($failure.Message)"
  exit 2
}

function Invoke-OciJson([string[]]$ociArgs, [string]$what) {
  $r = Invoke-Oci $ociArgs
  if ($r.ExitCode -ne 0) { Stop-Fatal $what (Get-OciFailure $r.Stderr) }
  if (-not $r.Stdout.Trim()) { return $null }
  return ($r.Stdout | ConvertFrom-Json)
}

# --- Resolve everything ONCE (and refuse anything that is not the approved config) -----------
if (-not (Test-Path $SshPublicKeyPath)) { throw "No existe la clave publica $SshPublicKeyPath" }
$pub = (Get-Content -Raw -Path $SshPublicKeyPath)
if ($pub -match 'PRIVATE KEY') { throw "$SshPublicKeyPath es una clave PRIVADA: usa el archivo .pub" }
if ($pub -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)') { throw "$SshPublicKeyPath no parece una clave publica SSH" }

Write-Log "INFO" "inicio (perfil $OciProfile, $DisplayName, $Shape $Ocpus OCPU / $MemoryGb GB, dry-run=$([bool]$DryRun))"

$subnets = Invoke-OciJson @("network", "subnet", "list", "--compartment-id", $CompartmentId, "--display-name", $SubnetName, "--lifecycle-state", "AVAILABLE", "--all") "buscar la subred $SubnetName"
if (-not $subnets -or @($subnets.data).Count -ne 1) { throw "Esperaba exactamente una subred '$SubnetName' en el compartimento" }
$subnetId = @($subnets.data)[0].id
Write-Log "INFO" "subred $SubnetName = $subnetId"

if (-not $AvailabilityDomain) {
  $ads = Invoke-OciJson @("iam", "availability-domain", "list", "--compartment-id", $CompartmentId) "listar dominios de disponibilidad"
  if (-not $ads -or @($ads.data).Count -ne 1) { throw "La region tiene $(@($ads.data).Count) dominios de disponibilidad: pasa -AvailabilityDomain" }
  $AvailabilityDomain = @($ads.data)[0].name
}
Write-Log "INFO" "dominio de disponibilidad = $AvailabilityDomain"

if (-not $ImageId) {
  $images = Invoke-OciJson @("compute", "image", "list", "--compartment-id", $CompartmentId,
    "--operating-system", "Canonical Ubuntu", "--operating-system-version", "24.04",
    "--shape", $Shape, "--lifecycle-state", "AVAILABLE", "--sort-by", "TIMECREATED", "--sort-order", "DESC", "--all") "buscar la imagen Ubuntu 24.04"
  if (-not $images) { throw "No hay imagenes 'Canonical Ubuntu 24.04' para $Shape visibles en el compartimento" }
  $candidate = @($images.data) | Where-Object { $_.'display-name' -notmatch 'Minimal' -and $_.'display-name' -match 'aarch64' } | Select-Object -First 1
  if (-not $candidate) { throw "No encontre una imagen 'Canonical Ubuntu 24.04' aarch64 (no Minimal) para $Shape" }
  $ImageId = $candidate.id
  Write-Log "INFO" "imagen = $($candidate.'display-name')"
}

function Get-ExistingInstance {
  $list = Invoke-OciJson @("compute", "instance", "list", "--compartment-id", $CompartmentId, "--display-name", $DisplayName, "--all") "listar instancias"
  if (-not $list) { return $null }
  return (@($list.data) | Where-Object { $_.'lifecycle-state' -notin @("TERMINATED", "TERMINATING") } | Select-Object -First 1)
}

$shapeConfigFile = Join-Path $logDir "shape-config.json"
Set-Content -Path $shapeConfigFile -Value ('{"ocpus": ' + $Ocpus + ', "memoryInGBs": ' + $MemoryGb + '}') -Encoding ASCII

$launchArgs = @("compute", "instance", "launch", "--no-retry",
  "--compartment-id", $CompartmentId,
  "--availability-domain", $AvailabilityDomain,
  "--display-name", $DisplayName,
  "--shape", $Shape,
  "--shape-config", ("file://" + $shapeConfigFile),
  "--image-id", $ImageId,
  "--subnet-id", $subnetId,
  "--assign-public-ip", "false",
  "--ssh-authorized-keys-file", $SshPublicKeyPath)

$existing = Get-ExistingInstance
if ($existing) {
  Write-Log "DONE" "ya existe $DisplayName ($($existing.'lifecycle-state')): no se crea otra"
  exit 0
}
if ($DryRun) {
  Write-Log "DRYRUN" "todo resuelto y con permisos de lectura OK; no se lanzo nada. Sin -DryRun empieza a reintentar."
  exit 0
}

# --- Retry loop -------------------------------------------------------------------------------
[void][SmartOps.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
$deadline = (Get-Date).AddDays($MaxDays)
$attempt = 0
try {
  while ((Get-Date) -lt $deadline) {
    $attempt++
    $existing = Get-ExistingInstance
    if ($existing) {
      Write-Log "DONE" "intento $($attempt): ya existe $DisplayName ($($existing.'lifecycle-state')), me detengo"
      Show-Alert "SmartOps: la VM existe" "$DisplayName esta $($existing.'lifecycle-state')."
      exit 0
    }

    $r = Invoke-Oci $launchArgs
    if ($r.ExitCode -eq 0) {
      $instance = ($r.Stdout | ConvertFrom-Json).data
      Write-Log "SUCCESS" "intento $($attempt): creada $DisplayName ($($instance.'lifecycle-state')) id=$($instance.id)"
      Show-Alert "SmartOps: VM creada!" "$DisplayName ($Shape $Ocpus OCPU / $MemoryGb GB). Segui con el paso 6.1 de la guia (IP reservada)."
      exit 0
    }

    $f = Get-OciFailure $r.Stderr
    switch ($f.Kind) {
      "capacity" { $wait = Get-Random -Minimum $MinWaitSeconds -Maximum ($MaxWaitSeconds + 1) }
      "throttled" { $wait = 900 }
      "transient" { $wait = Get-Random -Minimum $MinWaitSeconds -Maximum ($MaxWaitSeconds + 1) }
      default { Stop-Fatal "intento $($attempt)" $f }
    }
    # Never sleep past the deadline (the loop then ends and says so).
    $left = [int][math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
    if ($left -lt $wait) { $wait = [math]::Max(0, $left) }
    Write-Log $f.Kind.ToUpper() ("intento {0}: {1} {2} {3} -> proximo en {4} min" -f $attempt, $f.Status, $f.Code, $f.Message, [math]::Round($wait / 60, 1))
    Start-Sleep -Seconds $wait
  }
  Write-Log "STOP" "se cumplieron $MaxDays dias sin capacidad; me detengo (decidimos juntos que sigue)"
  Show-Alert "SmartOps: sin capacidad" "Pasaron $MaxDays dias de reintentos sin exito."
  exit 3
} finally {
  [void][SmartOps.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
