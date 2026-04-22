# One command: verify JDK + SDK, use a no-space build root (junction) on Windows,
# clean expo-av native cache, assembleRelease, adb install, print version proof.
#
# From repo root:
#   pnpm mobile:android:ship
#
# Does NOT use subst (different drive letter breaks Expo vs pnpm path-root checks).
# Uses a directory junction under %USERPROFILE%\.connect-mobile-build\repo -> real repo
# so tooling often sees a short, no-space *access* path on the same volume (still C:).
# If anything still fails, clone the repo to a path without spaces (e.g. C:\dev\connect2).

param(
  [switch]$SkipInstall,
  [switch]$SkipJunction
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$realRepo = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Find-JavaHome {
  # @(...) forces array: a single Where-Object hit is otherwise a scalar string, and then
  # .Count is string length and [0] is the first character (not a JDK path).
  $candidates = @(
    @(
      $env:JAVA_HOME,
      "$env:LOCALAPPDATA\Programs\Android\Android Studio\jbr",
      "${env:ProgramFiles}\Android\Android Studio\jbr",
      "${env:ProgramFiles}\Android\Android Studio\jre"
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "bin\java.exe")) }
  )
  if ($candidates.Count -gt 0) { return $candidates[0].TrimEnd('\') }
  $ms = Join-Path ${env:ProgramFiles} "Microsoft"
  if (Test-Path $ms) {
    foreach ($d in @(Get-ChildItem $ms -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      if (Test-Path (Join-Path $d.FullName "bin\java.exe")) { return $d.FullName.TrimEnd('\') }
    }
  }
  $adoptium = Join-Path ${env:ProgramFiles} "Eclipse Adoptium"
  if (Test-Path $adoptium) {
    foreach ($d in @(Get-ChildItem $adoptium -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      if (Test-Path (Join-Path $d.FullName "bin\java.exe")) { return $d.FullName.TrimEnd('\') }
    }
  }
  $javaDir = Join-Path ${env:ProgramFiles} "Java"
  if (Test-Path $javaDir) {
    foreach ($d in @(Get-ChildItem $javaDir -Directory -ErrorAction SilentlyContinue)) {
      if (Test-Path (Join-Path $d.FullName "bin\java.exe")) { return $d.FullName.TrimEnd('\') }
    }
  }
  return $null
}

function Ensure-Jdk {
  $jh = Find-JavaHome
  if ($jh) {
    $env:JAVA_HOME = [string]$jh
    $env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
    return $true
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { return $false }
  Write-Host "Installing Microsoft OpenJDK 17 via winget..."
  & winget install --id Microsoft.OpenJDK.17 -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { return $false }
  Start-Sleep -Seconds 2
  $jh = Find-JavaHome
  if (-not $jh) { return $false }
  $env:JAVA_HOME = [string]$jh
  $env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
  return $true
}

function Get-BuildRepoRoot([string]$canonicalRealRepo) {
  if ($SkipJunction) { return $canonicalRealRepo }
  # Short access path: no spaces in the junction path segment (parent is under USERPROFILE).
  $needsHelp = $canonicalRealRepo.Contains(" ")
  if (-not $needsHelp) { return $canonicalRealRepo }

  $parent = Join-Path $env:USERPROFILE ".connect-mobile-build"
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $junction = Join-Path $parent "repo"
  if (Test-Path $junction) {
    $item = Get-Item -LiteralPath $junction -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $target = $item.Target
      if ($target -is [string[]]) { $target = $target[0] }
      $normTarget = (Resolve-Path -LiteralPath $target).Path
      if ($normTarget -ne $canonicalRealRepo) {
        Write-Host "Removing stale junction $junction (was -> $normTarget)"
        Remove-Item -LiteralPath $junction -Force
      }
    } else {
      Write-Error "$junction exists and is not a junction. Remove it or use -SkipJunction."
      exit 1
    }
  }
  if (-not (Test-Path $junction)) {
    Write-Host "Creating junction:`n  $junction`n  ->`n  $canonicalRealRepo"
    New-Item -ItemType Junction -Path $junction -Target $canonicalRealRepo -Force | Out-Null
  }
  return (Resolve-Path -LiteralPath $junction).Path
}

function Clear-ExpoAvCxx([string]$root) {
  $pnpmRoot = Join-Path $root "node_modules\.pnpm"
  if (-not (Test-Path $pnpmRoot)) { return }
  Get-ChildItem $pnpmRoot -Filter "expo-av@*" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cxx = Join-Path $_.FullName "node_modules\expo-av\android\.cxx"
    if (Test-Path $cxx) {
      Write-Host "Removing $cxx"
      Remove-Item -Recurse -Force $cxx
    }
  }
}

Write-Step "Connect mobile - android-ship"
Write-Host "Real repo: $realRepo"

Write-Step "JDK"
if (-not (Ensure-Jdk)) {
  Write-Error "No JDK 17+ found and winget install failed. Install Microsoft OpenJDK 17 or Android Studio, then re-run: pnpm mobile:android:ship"
  exit 1
}
Write-Host "JAVA_HOME=$env:JAVA_HOME"
& java -version

Write-Step "Android SDK (adb)"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  Write-Error "adb not found at $adb - install Android Studio SDK Platform-Tools."
  exit 1
}

Write-Step "Build root (junction if path has spaces)"
$buildRoot = Get-BuildRepoRoot $realRepo
Write-Host "Using build root: $buildRoot"

$env:SHIP_BUILD_ID = Get-Date -Format "yyyyMMdd-HHmmss"
$env:SHIP_VERSION_CODE = [string]([int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() % 2100000000))
Write-Host "SHIP_BUILD_ID=$env:SHIP_BUILD_ID SHIP_VERSION_CODE=$env:SHIP_VERSION_CODE"

Write-Step "Clean expo-av CMake output"
Clear-ExpoAvCxx $buildRoot

$androidDir = Join-Path $buildRoot "apps\mobile\android"
if (-not (Test-Path (Join-Path $androidDir "gradlew.bat"))) {
  Write-Error "Gradle project not found at $androidDir"
  exit 1
}

Write-Step "Gradle assembleRelease (arm64-v8a, no daemon)"
Set-Location $androidDir
& .\gradlew.bat --no-daemon assembleRelease "-PreactNativeArchitectures=arm64-v8a"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $buildRoot "apps\mobile\android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) {
  Write-Error "APK missing: $apk"
  exit 1
}
Write-Host "APK: $apk ($((Get-Item $apk).Length) bytes)" -ForegroundColor Green

function Write-ShipProof([hashtable]$Extra) {
  $proofPath = Join-Path $realRepo "apps\mobile\ship-proof.json"
  $base = [ordered]@{
    completedAt      = (Get-Date).ToString("o")
    shipBuildId      = $env:SHIP_BUILD_ID
    shipVersionCode  = $env:SHIP_VERSION_CODE
    apkPath           = $apk
    apkBytes          = (Get-Item $apk).Length
    buildRoot         = $buildRoot
    realRepo          = $realRepo
    skipInstall       = [bool]$SkipInstall
  }
  foreach ($k in $Extra.Keys) { $base[$k] = $Extra[$k] }
  $base | ConvertTo-Json -Depth 5 | Set-Content -Path $proofPath -Encoding UTF8
  Write-Host "Wrote $proofPath" -ForegroundColor Green
}

if ($SkipInstall) {
  Write-ShipProof @{}
  Write-Host "SkipInstall set - done."
  exit 0
}

Write-Step "adb install"
$devices = & $adb devices | Where-Object { $_ -match "`tdevice$" }
if (-not $devices) {
  Write-Error "No device in 'adb devices'. Connect phone with USB debugging."
  exit 1
}
& $adb install -r -d $apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Step "Installed package proof"
$verLines = @(
  & $adb shell dumpsys package com.connectcommunications.mobile 2>&1 |
    Select-String -Pattern "versionName|versionCode" |
    Select-Object -First 8 |
    ForEach-Object { $_.Line }
)
$verLines | ForEach-Object { Write-Host $_ }

Write-ShipProof @{ adbInstall = $true; dumpsysVersionLines = $verLines }

Write-Host ""
Write-Host "Done. Live capture: pnpm mobile:live-capture -- -Scenario ring-home" -ForegroundColor Green
