# Build Connect mobile release APK (arm64-v8a) from Gradle — no USB device required.
# Prefer full pipeline: pnpm mobile:android:ship
#
# Requires: JDK 17+ (JAVA_HOME or Android Studio JBR). Android SDK optional here (no adb).

param(
  [string]$RepoRoot = $(Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$androidDir = Join-Path $repoRoot "apps\mobile\android"

function Find-JavaHome {
  $candidates = @(
    $env:JAVA_HOME,
    "$env:LOCALAPPDATA\Programs\Android\Android Studio\jbr",
    "${env:ProgramFiles}\Android\Android Studio\jbr",
    "${env:ProgramFiles}\Android\Android Studio\jre"
  ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "bin\java.exe")) }
  if ($candidates.Count -gt 0) { return $candidates[0] }
  $studio = Join-Path ${env:ProgramFiles} "Android"
  if (Test-Path $studio) {
    Get-ChildItem $studio -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $jbr = Join-Path $_.FullName "jbr"
      if (Test-Path (Join-Path $jbr "bin\java.exe")) { return $jbr }
    }
  }
  $ms = Join-Path ${env:ProgramFiles} "Microsoft"
  if (Test-Path $ms) {
    Get-ChildItem $ms -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName "bin\java.exe")) { return $_.FullName }
    }
  }
  $adoptium = Join-Path ${env:ProgramFiles} "Eclipse Adoptium"
  if (Test-Path $adoptium) {
    Get-ChildItem $adoptium -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName "bin\java.exe")) { return $_.FullName }
    }
  }
  $javaDir = Join-Path ${env:ProgramFiles} "Java"
  if (Test-Path $javaDir) {
    Get-ChildItem $javaDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName "bin\java.exe")) { return $_.FullName }
    }
  }
  return $null
}

$javaHome = Find-JavaHome
if (-not $javaHome) {
  Write-Error @"
JAVA_HOME not set and no JDK found. Install Android Studio or a JDK 17+, then either:
  setx JAVA_HOME "C:\Path\To\jbr"
or run this script from a Developer PowerShell where JAVA_HOME is already set.
"@
  exit 1
}

$env:JAVA_HOME = $javaHome.TrimEnd('\')
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"

Write-Host "Using JAVA_HOME=$env:JAVA_HOME"
& java -version

# Optional: clear expo-av CMake cache (fixes Windows ninja 'build.ninja still dirty' loops).
$pnpmRoot = Join-Path $repoRoot "node_modules\.pnpm"
if (Test-Path $pnpmRoot) {
  Get-ChildItem $pnpmRoot -Filter "expo-av@*" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cxx = Join-Path $_.FullName "node_modules\expo-av\android\.cxx"
    if (Test-Path $cxx) {
      Write-Host "Removing $cxx"
      Remove-Item -Recurse -Force $cxx
    }
  }
}

Set-Location $androidDir
Write-Host "Running assembleRelease (arm64-v8a)..."
& .\gradlew.bat assembleRelease --no-daemon "-PreactNativeArchitectures=arm64-v8a"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $repoRoot "apps\mobile\android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) {
  Write-Error "APK not found at $apk"
  exit 1
}

$outDir = Join-Path $repoRoot "apps\mobile\dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $outDir "connect-android-release-$stamp.apk"
Copy-Item $apk $out -Force
Write-Host ""
Write-Host "OK: $($apk | Get-Item | Select-Object -ExpandProperty Length) bytes"
Write-Host "Copy: $out"
Write-Host ""
Write-Host "Install: adb install -r `"$out`""
