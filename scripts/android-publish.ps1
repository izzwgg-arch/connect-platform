# Publish a freshly-built Android release APK to the production server's
# public download directory so it can be installed straight from the user
# invitation email link.
#
# What it does:
#   1. Locates the latest release APK (from the standard Gradle output dir).
#   2. Reads the version from apps/mobile/package.json.
#   3. SCPs the APK to /opt/connectcomms/downloads/ on the deploy host as
#      `connectcomms-vX.Y.Z.apk`, then atomically promotes it to
#      `connectcomms-latest.apk` and writes a small JSON manifest the
#      `/mobile/android/latest` API endpoint reads.
#   4. Smoke-tests the public download URL and prints the final URL.
#
# Usage (from repo root):
#   pwsh -File scripts/android-publish.ps1                # uses ssh alias `connect`
#   pwsh -File scripts/android-publish.ps1 -SshHost connect -ApkPath C:\path\to\app-release.apk
#   pwsh -File scripts/android-publish.ps1 -DryRun
#
# This script does NOT trigger a build. Run `pnpm mobile:android:ship`
# (or `gradlew assembleRelease`) first; this only publishes.

[CmdletBinding()]
param(
  [string]$SshHost = "connect",
  [string]$RemoteDir = "/opt/connectcomms/downloads",
  [string]$PublicBaseUrl = "https://app.connectcomunications.com/api/downloads",
  [string]$ApkPath = "",
  [string]$Version = "",
  [switch]$DryRun,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Info($m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Write-Err($m)  { Write-Host "  $m" -ForegroundColor Red }

# 1. Locate the APK.
if (-not $ApkPath) {
  $candidates = @(
    (Join-Path $repoRoot "apps\mobile\android\app\build\outputs\apk\release\app-release.apk"),
    (Join-Path "$env:USERPROFILE" ".connect-mobile-build\repo\apps\mobile\android\app\build\outputs\apk\release\app-release.apk")
  )
  $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $found) {
    Write-Err "No release APK found. Build first with: pnpm mobile:android:ship"
    Write-Err "Searched:"
    foreach ($c in $candidates) { Write-Err "  - $c" }
    exit 1
  }
  $ApkPath = $found
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
  Write-Err "APK not found: $ApkPath"
  exit 1
}

# 2. Read version from apps/mobile/package.json (override with -Version).
if (-not $Version) {
  $pkgPath = Join-Path $repoRoot "apps\mobile\package.json"
  if (Test-Path -LiteralPath $pkgPath) {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    if ($pkg.version) { $Version = [string]$pkg.version }
  }
}
if (-not $Version) {
  Write-Err "Could not determine version. Pass -Version 1.0.0 explicitly."
  exit 1
}
if ($Version -notmatch '^\d+\.\d+\.\d+([+\-][A-Za-z0-9.\-]+)?$') {
  Write-Err "Invalid version '$Version'. Expected semver (e.g. 1.0.0 or 1.0.0+20260501)."
  exit 1
}

$apkSize = (Get-Item -LiteralPath $ApkPath).Length
$versionedName = "connectcomms-v$Version.apk"
$latestName    = "connectcomms-latest.apk"
$manifestName  = "connectcomms-latest.json"
$manifest = @{
  version     = $Version
  filename    = $latestName
  publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  sizeBytes   = [int64]$apkSize
} | ConvertTo-Json -Compress

Write-Step "Android APK publish"
Write-Info "Source APK    : $ApkPath"
Write-Info "Size          : $([math]::Round($apkSize / 1MB, 2)) MB"
Write-Info "Version       : $Version"
Write-Info "Remote host   : $SshHost"
Write-Info "Remote dir    : $RemoteDir"
Write-Info "Public URL    : $PublicBaseUrl/$latestName"

if ($DryRun) {
  Write-Step "Dry run — no upload performed"
  Write-Ok "Would upload as $versionedName then promote to $latestName"
  exit 0
}

# 3. Make sure the remote directory exists with safe permissions.
Write-Step "Ensure remote download directory"
$mkdirCmd = "mkdir -p '$RemoteDir' && chmod 755 '$RemoteDir' && ls -la '$RemoteDir' | head -20"
& ssh $SshHost "bash -lc `"$mkdirCmd`""
if ($LASTEXITCODE -ne 0) {
  Write-Err "Failed to prepare remote directory."
  exit 1
}

# 4. SCP the APK with a tmp suffix, then atomically rename. Avoids partial reads.
Write-Step "Upload APK"
$remoteTmp = "$RemoteDir/$versionedName.tmp"
$remoteFinal = "$RemoteDir/$versionedName"
$remoteLatest = "$RemoteDir/$latestName"

& scp -p $ApkPath "${SshHost}:$remoteTmp"
if ($LASTEXITCODE -ne 0) {
  Write-Err "scp failed."
  exit 1
}

$promoteCmd = @"
set -e
mv -f '$remoteTmp' '$remoteFinal'
chmod 644 '$remoteFinal'
cp -f '$remoteFinal' '$remoteLatest.tmp'
mv -f '$remoteLatest.tmp' '$remoteLatest'
chmod 644 '$remoteLatest'
cat <<'JSON' > '$RemoteDir/$manifestName.tmp'
$manifest
JSON
mv -f '$RemoteDir/$manifestName.tmp' '$RemoteDir/$manifestName'
chmod 644 '$RemoteDir/$manifestName'
ls -la '$RemoteDir' | grep -E 'connectcomms|^total'
"@

& ssh $SshHost "bash -lc `"$promoteCmd`""
if ($LASTEXITCODE -ne 0) {
  Write-Err "Failed to promote APK on remote host."
  exit 1
}

# 5. Smoke-test the public URL (HEAD request).
$publicVersionedUrl = "$PublicBaseUrl/$versionedName"
$publicLatestUrl    = "$PublicBaseUrl/$latestName"

if (-not $SkipSmokeTest) {
  Write-Step "Smoke-test public URLs"
  try {
    $r1 = Invoke-WebRequest -Method Head -Uri $publicLatestUrl -MaximumRedirection 0 -ErrorAction Stop
    Write-Ok "HEAD $publicLatestUrl => $($r1.StatusCode) $($r1.StatusDescription) ($($r1.Headers['Content-Length']) bytes, $($r1.Headers['Content-Type']))"
  } catch {
    Write-Err "HEAD failed for $publicLatestUrl"
    Write-Err $_.Exception.Message
  }
  try {
    $r2 = Invoke-WebRequest -Method Head -Uri $publicVersionedUrl -MaximumRedirection 0 -ErrorAction Stop
    Write-Ok "HEAD $publicVersionedUrl => $($r2.StatusCode) $($r2.StatusDescription) ($($r2.Headers['Content-Length']) bytes)"
  } catch {
    Write-Err "HEAD failed for $publicVersionedUrl"
    Write-Err $_.Exception.Message
  }
}

Write-Step "Done"
Write-Ok "Latest URL    : $publicLatestUrl"
Write-Ok "Versioned URL : $publicVersionedUrl"
