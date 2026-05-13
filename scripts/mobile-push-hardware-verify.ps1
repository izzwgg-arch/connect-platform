# Mobile push / ring hardware verification helper (PowerShell).
# Does NOT ship or commit. Use after connecting USB + enabling USB debugging.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/mobile-push-hardware-verify.ps1
#   powershell -File scripts/mobile-push-hardware-verify.ps1 -SkipInstall
#   powershell -File scripts/mobile-push-hardware-verify.ps1 -ApkPath "C:\path\app-release.apk"
#
# Prerequisite: Android SDK platform-tools on PATH, or set $env:ANDROID_HOME.

param(
  [string]$ApkPath = "",
  [switch]$SkipInstall,
  [switch]$LogcatOnly
)

$ErrorActionPreference = "Stop"

function Get-Adb {
  $fromPath = (Get-Command adb -ErrorAction SilentlyContinue)?.Source
  if ($fromPath) { return $fromPath }
  $sdk = $env:ANDROID_HOME
  if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
  $adb = Join-Path $sdk "platform-tools\adb.exe"
  if (-not (Test-Path $adb)) {
    throw "adb not found. Install platform-tools or add adb to PATH. Tried: $adb"
  }
  return $adb
}

$adb = Get-Adb

Write-Host "[verify] adb kill-server / start-server / devices -l"
& $adb kill-server 2>$null
Start-Sleep -Milliseconds 400
& $adb start-server
& $adb devices -l

$lines = (& $adb devices) | Where-Object { $_ -match "`tdevice$" }
if (-not $lines -or $lines.Count -lt 1) {
  Write-Error @"
No device in 'device' state.

Checklist:
  - Phone unlocked; USB mode = File transfer / MTP (not charge-only)
  - Developer options + USB debugging on
  - Revoke USB debugging authorizations, replug, accept prompt
  - Different cable / USB port; Samsung USB driver in Device Manager
"@
  exit 1
}

if ($LogcatOnly) {
  Write-Host "[verify] logcat only (clear + follow). Ctrl+C to stop."
  & $adb logcat -c
  & $adb logcat -v time IncomingCallFirebaseService:I ConnectCallFlow:I ReactNativeJS:I "*:S"
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultApk = Join-Path $repoRoot "apps\mobile\android\app\build\outputs\apk\release\app-release.apk"
if (-not $ApkPath) { $ApkPath = $defaultApk }

if (-not $SkipInstall) {
  if (-not (Test-Path $ApkPath)) {
    Write-Error "APK not found: $ApkPath`nBuild first: cd apps\mobile\android; .\gradlew.bat assembleRelease"
    exit 1
  }
  Write-Host "[verify] adb install -r $ApkPath"
  & $adb install -r $ApkPath
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "[verify] adb logcat -c (buffer cleared)"
& $adb logcat -c

Write-Host @"

--- Next: run matrix (manual) while capturing ---

Terminal A (device):
  adb logcat -v time IncomingCallFirebaseService:I ConnectCallFlow:I ReactNativeJS:I *:S

Markers:
  - Native user alerts:  CONNECT_USER_ALERT  (logcat)
  - API audit (server): MOBILE_PUSH_AUDIT, mobile_push_audit.expo_messages_built / expo_response
  - Telephony divert:   mobile-ring: notifying API of diverted_to_voicemail
  - INVITE_CANCELED:    native_termination ... reason=...

APK string note: MOBILE_PUSH_AUDIT and diverted_to_voicemail are not in the mobile APK
(API / telephony / worker). Confirm them on server logs or DB for Step 4.

"@
