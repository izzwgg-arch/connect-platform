# Build the Google Play AAB (Android App Bundle) for the Loopcom app.
#
# From repo root:
#   powershell -File scripts/android-play-bundle.ps1 -VersionCode 100 -VersionName "1.0.0"
#
# This is the ONLY sanctioned way to produce a Play-signable artifact:
#   - Signs with the Play upload key (apps/mobile/android/app/play-upload.keystore,
#     credentials in the gitignored apps/mobile/android/keystore.properties) via
#     CONNECT_PLAY_SIGNING=1. Sideload builds (scripts/android-ship.ps1) keep the
#     historical debug signing on purpose — the installed fleet carries that
#     signature and must keep updating in place from the download page.
#   - Uses small monotonic PLAY_VERSION_CODE values (100, 101, ...) instead of the
#     sideload timestamp scheme, which would exhaust Play's 2.1e9 ceiling by ~2036.
#   - Builds bundleRelease with armeabi-v7a + arm64-v8a so 32-bit ARM devices are
#     covered (the sideload APK is deliberately arm64-only for Windows build
#     reliability; the AAB serves per-device splits so size is not a concern).
#
# NOTE: unlike android-ship.ps1 this does NOT rewrite strings.xml or touch the
# working tree, and never installs to a device.

param(
  [Parameter(Mandatory = $true)][int]$VersionCode,
  [string]$VersionName = "1.0.0",
  [string]$Abis = "armeabi-v7a,arm64-v8a"
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$realRepo = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Find-JavaHome {
  $candidates = @(
    @(
      $env:JAVA_HOME,
      "$env:LOCALAPPDATA\Programs\Android\Android Studio\jbr",
      "${env:ProgramFiles}\Android\Android Studio\jbr"
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "bin\java.exe")) }
  )
  if ($candidates.Count -gt 0) { return $candidates[0].TrimEnd('\') }
  foreach ($base in @((Join-Path ${env:ProgramFiles} "Microsoft"), (Join-Path ${env:ProgramFiles} "Eclipse Adoptium"), (Join-Path ${env:ProgramFiles} "Java"))) {
    if (Test-Path $base) {
      foreach ($d in @(Get-ChildItem $base -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
        if (Test-Path (Join-Path $d.FullName "bin\java.exe")) { return $d.FullName.TrimEnd('\') }
      }
    }
  }
  return $null
}

Write-Step "Loopcom - android-play-bundle (versionCode=$VersionCode versionName=$VersionName abis=$Abis)"

Write-Step "JDK"
$jh = Find-JavaHome
if (-not $jh) { Write-Error "No JDK found. Install Microsoft OpenJDK 17."; exit 1 }
$env:JAVA_HOME = [string]$jh
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
Write-Host "JAVA_HOME=$env:JAVA_HOME"

Write-Step "Signing credentials"
$ksProps = Join-Path $realRepo "apps\mobile\android\keystore.properties"
$ksFile = Join-Path $realRepo "apps\mobile\android\app\play-upload.keystore"
if (-not (Test-Path $ksProps)) { Write-Error "Missing $ksProps - the Play upload key credentials. Refusing to build."; exit 1 }
if (-not (Test-Path $ksFile)) { Write-Error "Missing $ksFile - the Play upload keystore. Refusing to build."; exit 1 }
Write-Host "Upload keystore + credentials present."

# Clean stale expo-av CMake output (the known Windows ninja trap).
$pnpmRoot = Join-Path $realRepo "node_modules\.pnpm"
if (Test-Path $pnpmRoot) {
  Get-ChildItem $pnpmRoot -Filter "expo-av@*" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cxx = Join-Path $_.FullName "node_modules\expo-av\android\.cxx"
    if (Test-Path $cxx) { Write-Host "Removing $cxx"; Remove-Item -Recurse -Force $cxx }
  }
}

$env:CONNECT_PLAY_SIGNING = "1"
$env:PLAY_VERSION_CODE = [string]$VersionCode
$env:PLAY_VERSION_NAME = $VersionName
# Make sure the sideload vars can't leak in from a prior shell.
$env:SHIP_BUILD_ID = ""
$env:SHIP_VERSION_CODE = ""

$androidDir = Join-Path $realRepo "apps\mobile\android"
if (-not (Test-Path (Join-Path $androidDir "gradlew.bat"))) { Write-Error "Gradle project not found at $androidDir"; exit 1 }

Write-Step "Gradle bundleRelease ($Abis, no daemon)"
Set-Location $androidDir
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& .\gradlew.bat --no-daemon bundleRelease "-PreactNativeArchitectures=$Abis" 2>&1 | ForEach-Object { Write-Host $_ }
$gradleExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($gradleExit -ne 0) { exit $gradleExit }

$aab = Join-Path $androidDir "app\build\outputs\bundle\release\app-release.aab"
if (-not (Test-Path $aab)) { Write-Error "AAB missing: $aab"; exit 1 }

$distDir = Join-Path $realRepo "apps\mobile\dist"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir -Force | Out-Null }
$outName = "loopcom-play-vc$VersionCode.aab"
$outPath = Join-Path $distDir $outName
Copy-Item -LiteralPath $aab -Destination $outPath -Force

Write-Host ""
Write-Host "AAB ready: $outPath ($((Get-Item $outPath).Length) bytes)" -ForegroundColor Green
Write-Host "Upload this file in Play Console -> Release -> (track) -> Create new release." -ForegroundColor Green
