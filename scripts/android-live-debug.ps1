# One-place helpers for USB live debugging (logcat + optional scrcpy).
# Repo root: see docs/android-incoming-call-live-debug.md
#
# Examples:
#   .\scripts\android-live-debug.ps1 -Action print-commands
#   .\scripts\android-live-debug.ps1 -Action clear
#   .\scripts\android-live-debug.ps1 -Action capture -Scenario ring-home
#   .\scripts\android-live-debug.ps1 -Action mirror     # requires scrcpy on PATH

param(
  [ValidateSet("print-commands", "clear", "capture", "mirror", "both")]
  [string]$Action = "print-commands",
  [string]$Scenario = "general"
)

$ErrorActionPreference = "Stop"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  Write-Error "adb not found at $adb"
  exit 1
}
$repoRoot = Split-Path -Parent $PSScriptRoot

function Get-Scrcpy {
  $cmd = Get-Command scrcpy -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $local = Join-Path $env:USERPROFILE "scoop\apps\scrcpy\current\scrcpy.exe"
  if (Test-Path $local) { return $local }
  return $null
}

switch ($Action) {
  "print-commands" {
    Write-Host ""
    Write-Host "=== Connect — Android live debug (copy/paste) ==="
    Write-Host ""
    Write-Host "Clear logcat:"
    Write-Host "  & `"$adb`" logcat -c"
    Write-Host ""
    Write-Host "Stream high-signal tags (terminal):"
    Write-Host "  & `"$adb`" logcat -v threadtime *:S IncomingCallService:V ConnectCallFlow:V ConnectMainActivity:V FirebaseMessaging:V ReactNativeJS:V ReactNative:V ExpoModules:V"
    Write-Host ""
    Write-Host "Grep JS timeline only (PowerShell):"
    Write-Host "  & `"$adb`" logcat -v threadtime | Select-String 'CALL_FLOW|CALL_TIMELINE|ANSWER_FLOW|CALL_INCOMING'"
    Write-Host ""
    Write-Host "Screen mirror (install scrcpy: https://github.com/Genymobile/scrcpy ):"
    Write-Host "  scrcpy"
    Write-Host ""
    Write-Host "Capture to file (from repo root):"
    Write-Host "  pnpm mobile:live-capture -- -Scenario $Scenario"
    Write-Host ""
  }
  "clear" {
    & $adb logcat -c
    Write-Host "logcat cleared."
  }
  "capture" {
    $cap = Join-Path $repoRoot "scripts\android-live-capture.ps1"
    & $cap -Scenario $Scenario
  }
  "mirror" {
    $sc = Get-Scrcpy
    if (-not $sc) {
      Write-Error "scrcpy not found on PATH. Install from https://github.com/Genymobile/scrcpy or add to PATH."
      exit 1
    }
    Start-Process -FilePath $sc -ArgumentList @("--stay-awake", "--turn-screen-on") -NoNewWindow:$false
    Write-Host "Started scrcpy: $sc"
  }
  "both" {
    $sc = Get-Scrcpy
    if ($sc) {
      Start-Process -FilePath $sc -ArgumentList @("--stay-awake") -WindowStyle Normal
      Start-Sleep -Seconds 2
    } else {
      Write-Warning "scrcpy not found — only starting log capture."
    }
    $cap = Join-Path $repoRoot "scripts\android-live-capture.ps1"
    & $cap -Scenario $Scenario
  }
}
