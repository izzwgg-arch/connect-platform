# Live JS iteration on a physical Android device over USB (no APK rebuild for TS/TSX).
#
# Prerequisites:
#   1. Install a DEVELOPMENT build on the phone (expo-dev-client), e.g.:
#        cd apps/mobile && pnpm exec expo run:android
#      or EAS "development" profile. The release APK from assembleRelease will NOT load Metro.
#   2. USB debugging on; phone plugged in; same machine runs this script.
#
# What this does:
#   - adb reverse so the device can reach Metro on this PC (localhost:8081).
#   - Starts Expo for dev client with --localhost (required for reverse to work).
#
# Usage (repo root):
#   pnpm mobile:dev-live
#
# Optional — only set up port reverse, then start Metro yourself:
#   powershell -File scripts/mobile-android-live.ps1 -ReverseOnly

param(
  [switch]$ReverseOnly
)

$ErrorActionPreference = "Stop"

$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  Write-Error "adb not found at $adb. Install Android SDK platform-tools."
  exit 1
}

Write-Host "[mobile-live] Checking device..."
$devLines = (& $adb devices) | Where-Object { $_ -match "\tdevice$" }
if (-not $devLines -or $devLines.Count -lt 1) {
  Write-Error "No Android device in 'device' state. Run 'adb devices', enable USB debugging, and authorize this PC."
  exit 1
}

Write-Host "[mobile-live] adb reverse (8081, 8082) for Metro / dev tools..."
& $adb reverse tcp:8081 tcp:8081
& $adb reverse tcp:8082 tcp:8082

if ($ReverseOnly) {
  Write-Host "[mobile-live] Done (reverse only). Start Metro from apps/mobile with: pnpm start:dev-client:usb"
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$mobileDir = Join-Path $repoRoot "apps\mobile"
if (-not (Test-Path $mobileDir)) {
  Write-Error "apps/mobile not found at $mobileDir"
  exit 1
}

Set-Location $mobileDir
Write-Host "[mobile-live] Starting Metro from $mobileDir"
Write-Host "[mobile-live] Open the Connect DEV CLIENT app on the phone — JS updates will fast-refresh."
Write-Host ""

pnpm exec expo start --dev-client --localhost
