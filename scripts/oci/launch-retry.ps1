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
  - "Out of host capacity" -> espera 2-5 min (al azar) y reintenta. 429 TooManyRequests -> 15 min.
  - Cortes de red (timeouts, DNS, conexion rechazada o cortada, cualquier falla sin ServiceError de
    OCI) -> se reintentan igual, en el listado y en el launch (seguro: antes de cada intento se
    verifica si la VM ya existe). Cada 12 seguidos avisa en el log y con una notificacion, y sigue
    hasta el plazo.
  - Errores reales (401, 404 de permisos, limites, parametros, configuracion local) -> se FRENA.
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
  [int]$MinWaitSeconds = 120,
  [int]$MaxWaitSeconds = 300,
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

# Classifies an OCI CLI failure.
#  - A ServiceError from OCI carries "code"/"status": capacity, 429 and 5xx are retried; 401, 404
#    (permissions), limits and bad parameters are FATAL.
#  - Local configuration / usage errors of the CLI itself (config file, key file, profile, bad
#    options) are FATAL: retrying would never fix them.
#  - Anything else without a ServiceError (timeouts, DNS, connection refused / reset, "Max retries
#    exceeded", RequestException / ConnectionError...) is a NETWORK failure and is retried. Safe,
#    because the existence of the instance is checked before every launch.
function Get-OciFailure([string]$stderr) {
  $code = ""; $status = ""; $message = ""
  if ($stderr -match '"code"\s*:\s*"([^"]+)"') { $code = $Matches[1] }
  if ($stderr -match '"status"\s*:\s*(\d+)') { $status = $Matches[1] }
  if ($stderr -match '"message"\s*:\s*"([^"]*)"') { $message = $Matches[1] }
  if (-not $message) { $message = [string]($stderr -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  if (-not $message) { $message = "(sin mensaje)" }
  $message = $message.Trim()
  if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
  $serviceError = ($stderr -match 'ServiceError') -and [bool]$code

  $kind = "fatal"
  if ($serviceError) {
    if ($message -match 'Out of host capacity' -or $message -match 'out of capacity') { $kind = "capacity" }
    elseif ($code -eq "TooManyRequests" -or $status -eq "429") { $kind = "throttled" }
    elseif ($status -match '^5\d\d$' -and $code -ne "InternalError") { $kind = "transient" }
  } elseif ($stderr -match 'ConfigFileNotFound|Could not find config file|ProfileNotFound|profile .* not found|key_file|InvalidKeyFilePath|private key|passphrase|InvalidConfig|No such option|Missing option|Invalid value|Usage: oci') {
    $code = "LocalConfig"
  } else {
    $kind = "network"
    $code = "Network"
  }
  return [pscustomobject]@{ Kind = $kind; Code = $code; Status = $status; Message = $message }
}

function Stop-Fatal([string]$what, $failure) {
  Write-Log "STOP" "$what -> $($failure.Status) $($failure.Code): $($failure.Message)"
  switch -Regex ($failure.Code) {
    '^NotAuthenticated$' { Write-Log "HINT" "Autenticacion: revisa ~/.oci/config (perfil $OciProfile), el fingerprint y la ruta de la clave." }
    '^NotAuthorizedOrNotFound$' { Write-Log "HINT" "Permisos: revisa la politica del grupo smartops-launchers o el OCID del compartimento." }
    'LimitExceeded|QuotaExceeded' { Write-Log "HINT" "Limite/cuota: puede que ya exista otra instancia A1 en la cuenta (Limits, Quotas and Usage)." }
    '^InvalidParameter$' { Write-Log "HINT" "Parametro invalido: revisa la imagen, la subred o el dominio de disponibilidad." }
    '^LocalConfig$' { Write-Log "HINT" "Configuracion local de OCI CLI: revisa ~/.oci/config (perfil $OciProfile) y la ruta de la clave." }
    '^Network$' { Write-Log "HINT" "Sin conexion con OCI (en -DryRun no se reintenta): revisa internet y volve a probar." }
  }
  Show-Alert "SmartOps: el reintento se freno" "$($failure.Code): $($failure.Message)"
  exit 2
}

$script:networkStreak = 0
$NetworkAlertEvery = 12

function Stop-Deadline {
  Write-Log "STOP" "se cumplieron $MaxDays dias sin crear la VM; me detengo (decidimos juntos que sigue)"
  Show-Alert "SmartOps: sin capacidad" "Pasaron $MaxDays dias de reintentos sin exito."
  exit 3
}

# Waits before the next try (never past the deadline). One log line per failed try.
function Wait-Retry([string]$what, $failure) {
  if ($failure.Kind -eq "network") {
    $script:networkStreak++
    if ($script:networkStreak % $NetworkAlertEvery -eq 0) {
      Write-Log "ALERT" "$($script:networkStreak) fallas de red seguidas; sigo reintentando hasta el plazo"
      Show-Alert "SmartOps: sin conexion con OCI" "$($script:networkStreak) fallas de red seguidas. El script sigue reintentando."
    }
  } else {
    $script:networkStreak = 0 # OCI answered with a real ServiceError: the network is fine
  }
  if ($failure.Kind -eq "throttled") { $wait = 900 }
  else { $wait = Get-Random -Minimum $MinWaitSeconds -Maximum ($MaxWaitSeconds + 1) }
  $left = [int][math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
  if ($left -lt $wait) { $wait = [math]::Max(0, $left) }
  $detail = (@($failure.Status, $failure.Code, $failure.Message) | Where-Object { $_ }) -join " "
  Write-Log $failure.Kind.ToUpper() ("{0}: {1} -> proximo en {2} min" -f $what, $detail, [math]::Round($wait / 60, 1))
  Start-Sleep -Seconds $wait
  if ((Get-Date) -ge $deadline) { Stop-Deadline }
}

# Read-only call (list / lookup): network, 5xx and 429 are retried until the deadline; any other
# error stops. In -DryRun nothing is retried (it reports and stops).
function Invoke-OciRead([string[]]$ociArgs, [string]$what) {
  while ($true) {
    $r = Invoke-Oci $ociArgs
    if ($r.ExitCode -eq 0) {
      # A successful listing does NOT reset the network streak: launches may still be failing.
      if (-not $r.Stdout.Trim()) { return $null }
      return ($r.Stdout | ConvertFrom-Json)
    }
    $f = Get-OciFailure $r.Stderr
    if ($DryRun -or $f.Kind -notin @("network", "transient", "throttled")) { Stop-Fatal $what $f }
    Wait-Retry $what $f
  }
}

# --- Resolve everything ONCE (and refuse anything that is not the approved config) -----------
if (-not (Test-Path $SshPublicKeyPath)) { throw "No existe la clave publica $SshPublicKeyPath" }
$pub = (Get-Content -Raw -Path $SshPublicKeyPath)
if ($pub -match 'PRIVATE KEY') { throw "$SshPublicKeyPath es una clave PRIVADA: usa el archivo .pub" }
if ($pub -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)') { throw "$SshPublicKeyPath no parece una clave publica SSH" }

Write-Log "INFO" "inicio (perfil $OciProfile, $DisplayName, $Shape $Ocpus OCPU / $MemoryGb GB, espera $MinWaitSeconds-$MaxWaitSeconds s, dry-run=$([bool]$DryRun))"
$deadline = (Get-Date).AddDays($MaxDays)
if (-not $DryRun) { [void][SmartOps.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) }

try {
  $subnets = Invoke-OciRead @("network", "subnet", "list", "--compartment-id", $CompartmentId, "--display-name", $SubnetName, "--lifecycle-state", "AVAILABLE", "--all") "buscar la subred $SubnetName"
  if (-not $subnets -or @($subnets.data).Count -ne 1) { throw "Esperaba exactamente una subred '$SubnetName' en el compartimento" }
  $subnetId = @($subnets.data)[0].id
  Write-Log "INFO" "subred $SubnetName = $subnetId"

  if (-not $AvailabilityDomain) {
    $ads = Invoke-OciRead @("iam", "availability-domain", "list", "--compartment-id", $CompartmentId) "listar dominios de disponibilidad"
    if (-not $ads -or @($ads.data).Count -ne 1) { throw "No pude determinar un unico dominio de disponibilidad: pasa -AvailabilityDomain" }
    $AvailabilityDomain = @($ads.data)[0].name
  }
  Write-Log "INFO" "dominio de disponibilidad = $AvailabilityDomain"

  if (-not $ImageId) {
    $images = Invoke-OciRead @("compute", "image", "list", "--compartment-id", $CompartmentId,
      "--operating-system", "Canonical Ubuntu", "--operating-system-version", "24.04",
      "--shape", $Shape, "--lifecycle-state", "AVAILABLE", "--sort-by", "TIMECREATED", "--sort-order", "DESC", "--all") "buscar la imagen Ubuntu 24.04"
    if (-not $images) { throw "No hay imagenes 'Canonical Ubuntu 24.04' para $Shape visibles en el compartimento" }
    $candidate = @($images.data) | Where-Object { $_.'display-name' -notmatch 'Minimal' -and $_.'display-name' -match 'aarch64' } | Select-Object -First 1
    if (-not $candidate) { throw "No encontre una imagen 'Canonical Ubuntu 24.04' aarch64 (no Minimal) para $Shape" }
    $ImageId = $candidate.id
    Write-Log "INFO" "imagen = $($candidate.'display-name')"
  }

  function Get-ExistingInstance {
    $list = Invoke-OciRead @("compute", "instance", "list", "--compartment-id", $CompartmentId, "--display-name", $DisplayName, "--all") "listar instancias"
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

  # --- Retry loop -----------------------------------------------------------------------------
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt++
    # ALWAYS before launching: a previous launch may have worked even if its answer was lost.
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
    if ($f.Kind -notin @("capacity", "network", "transient", "throttled")) { Stop-Fatal "intento $($attempt)" $f }
    Wait-Retry "intento $($attempt)" $f
  }
  Stop-Deadline
} finally {
  [void][SmartOps.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
