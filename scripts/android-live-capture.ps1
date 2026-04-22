# Capture filtered logcat while you reproduce one issue on a USB-connected phone.
# After Ctrl+C, upload or paste: logs/android-live-<scenario>-<timestamp>.txt
#
# Usage (repo root; -- forwards args to this script):
#   pnpm mobile:live-capture -- -Scenario ring-home
#   pnpm mobile:live-capture -- -Scenario answer-flash
#   pnpm mobile:live-capture -- -Scenario hangup-blank
#   pnpm mobile:live-capture   # scenario defaults to "general"
#
# Then: place a test call, reproduce ONE problem, press Ctrl+C in this window.

param(
  [string]$Scenario = "general"
)

$ErrorActionPreference = "Stop"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  Write-Error "adb not found at $adb"
  exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $logDir "android-live-$Scenario-$ts.txt"

Write-Host ""
Write-Host "=== Connect — live capture ($Scenario) ==="
Write-Host "Log file: $out"
Write-Host ""
Write-Host "Reproduce ONE issue now (single scenario). When done, press Ctrl+C here."
Write-Host ""
Write-Host "Suggested scenarios:"
Write-Host "  ring-home       — App swiped away / home screen; expect ring + incoming UI"
Write-Host "  fullscreen      — Same; expect full-screen incoming, not only heads-up"
Write-Host "  answer-flash    — Answer from lock or notification; note splash / Call ended flash"
Write-Host "  hangup-blank    — Hang up from lock; note blank screen / restart"
Write-Host ""

& $adb logcat -c
# Silence all, then allow these tags (FCM uses FirebaseMessaging).
$logArgs = @(
  "-v", "threadtime",
  "*:S",
  "IncomingCallService:V",
  "ConnectCallFlow:V",
  "ConnectMainActivity:V",
  "FirebaseMessaging:V",
  "ReactNativeJS:V",
  "ReactNative:V",
  "ExpoModules:V"
)

try {
  & $adb logcat @logArgs | Tee-Object -FilePath $out
} finally {
  Write-Host ""
  Write-Host "Saved: $out"
  Write-Host "Share that file (or last ~200 lines) to continue fixes."
}
