# Publish a freshly-built Android release APK to the production server's
# public download directory so it can be installed straight from the user
# invitation email link.
#
# What it does:
#   1. Locates the latest release APK (from the standard Gradle output dir).
#   2. Reads the version from apps/mobile/package.json.
#   3. SCPs the APK to /opt/connectcomms/downloads/ on the deploy host as
#      "connectcomms-vX.Y.Z.apk", then atomically promotes it to
#      "connectcomms-latest.apk" and writes a small JSON manifest the
#      /mobile/android/latest API endpoint reads.
#   4. Smoke-tests the public download URL and prints the final URL.
#
# Usage (from repo root):
#   powershell -File scripts/android-publish.ps1
#   powershell -File scripts/android-publish.ps1 -SshHost connect -ApkPath C:\path\to\app-release.apk
#   powershell -File scripts/android-publish.ps1 -Version 1.0.0+9255c0e -CommitSha 9255c0e `
#     -ReleaseNotes "Fixes voicemail isolation/cache and playback on mobile."
#   powershell -File scripts/android-publish.ps1 -DryRun
#
# This script does NOT trigger a build. Run "pnpm mobile:android:ship"
# (or "gradlew assembleRelease") first; this only publishes.

[CmdletBinding()]
param(
  [string]$SshHost = "connect",
  [string]$RemoteDir = "/opt/connectcomms/downloads",
  [string]$PublicBaseUrl = "https://app.connectcomunications.com/api/downloads",
  [string]$ApkPath = "",
  [string]$Version = "",
  [string]$ReleaseNotes = "",
  [string]$CommitSha = "",
  [switch]$DryRun,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path

function Write-Step($m) { Write-Host ("`n=== {0} ===" -f $m) -ForegroundColor Cyan }
function Write-Info($m) { Write-Host ("  {0}" -f $m) -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host ("  {0}" -f $m) -ForegroundColor Green }
function Write-Err($m)  { Write-Host ("  {0}" -f $m) -ForegroundColor Red }

# 1. Locate the APK.
if (-not $ApkPath) {
  $candidates = @(
    (Join-Path $repoRoot "apps\mobile\android\app\build\outputs\apk\release\app-release.apk"),
    (Join-Path $env:USERPROFILE ".connect-mobile-build\repo\apps\mobile\android\app\build\outputs\apk\release\app-release.apk")
  )
  $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $found) {
    Write-Err "No release APK found. Build first with: pnpm mobile:android:ship"
    Write-Err "Searched:"
    foreach ($c in $candidates) { Write-Err ("  - {0}" -f $c) }
    exit 1
  }
  $ApkPath = $found
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
  Write-Err ("APK not found: {0}" -f $ApkPath)
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
  Write-Err ("Invalid version '{0}'. Expected semver (e.g. 1.0.0 or 1.0.0+20260501)." -f $Version)
  exit 1
}

$apkSize = (Get-Item -LiteralPath $ApkPath).Length
$versionedName = "connectcomms-v{0}.apk" -f $Version
$latestName    = "connectcomms-latest.apk"
$manifestName  = "connectcomms-latest.json"

Write-Step "Android APK publish"
Write-Info ("Source APK    : {0}" -f $ApkPath)
Write-Info ("Size          : {0} MB" -f ([math]::Round($apkSize / 1MB, 2)))
Write-Info ("Version       : {0}" -f $Version)
Write-Info ("Remote host   : {0}" -f $SshHost)
Write-Info ("Remote dir    : {0}" -f $RemoteDir)
Write-Info ("Public URL    : {0}/{1}" -f $PublicBaseUrl, $latestName)

if ($DryRun) {
  Write-Step "Dry run -- no upload performed"
  Write-Ok ("Would upload as {0} then promote to {1}" -f $versionedName, $latestName)
  exit 0
}

# Build a manifest JSON locally and scp it alongside the APK.
$manifestObj = [ordered]@{
  version     = $Version
  filename    = $latestName
  publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  sizeBytes   = [int64]$apkSize
}
if ($ReleaseNotes -and $ReleaseNotes.Trim().Length -gt 0) {
  $rn = $ReleaseNotes.Trim()
  $max = [Math]::Min(2000, $rn.Length)
  $manifestObj.releaseNotes = $rn.Substring(0, $max)
}
if ($CommitSha -and $CommitSha.Trim().Length -gt 0) {
  $sha = $CommitSha.Trim()
  if ($sha -match '^[0-9a-fA-F]{7,40}$') {
    $manifestObj.commitSha = $sha.ToLowerInvariant()
  } else {
    Write-Err ("Ignoring -CommitSha (expected 7–40 hex chars): {0}" -f $sha)
  }
}
$manifestJson = $manifestObj | ConvertTo-Json -Compress
$tmpManifest = [System.IO.Path]::GetTempFileName()
try {
  # Write the JSON manifest as plain UTF-8 *without* a BOM. Set-Content's
  # default UTF8 encoding adds a BOM that breaks strict JSON.parse on the
  # server side.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmpManifest, $manifestJson, $utf8NoBom)

  # Build the remote promote helper as a local file, then scp it. Avoids
  # heredoc-in-string headaches across PowerShell versions.
  $tmpHelper = [System.IO.Path]::GetTempFileName()
  $helperPath = "{0}.sh" -f $tmpHelper
  Move-Item -LiteralPath $tmpHelper -Destination $helperPath -Force

  $helper = @'
#!/usr/bin/env bash
set -e
REMOTE_DIR="$1"
VERSIONED_NAME="$2"
LATEST_NAME="$3"
MANIFEST_NAME="$4"

mkdir -p "$REMOTE_DIR"
chmod 755 "$REMOTE_DIR"

# Promote the .tmp upload to the versioned name.
mv -f "$REMOTE_DIR/$VERSIONED_NAME.tmp" "$REMOTE_DIR/$VERSIONED_NAME"
chmod 644 "$REMOTE_DIR/$VERSIONED_NAME"

# Preserve previous "latest" on disk for rollback (not served — filename not in allow-list).
if [ -f "$REMOTE_DIR/$LATEST_NAME" ]; then
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  cp -f "$REMOTE_DIR/$LATEST_NAME" "$REMOTE_DIR/connectcomms-latest.backup-$ts.apk" || true
  cp -f "$REMOTE_DIR/$LATEST_NAME" "$REMOTE_DIR/connectcomms-latest.previous.apk" || true
fi

# Atomically update the "latest" pointer.
cp -f "$REMOTE_DIR/$VERSIONED_NAME" "$REMOTE_DIR/$LATEST_NAME.tmp"
mv -f "$REMOTE_DIR/$LATEST_NAME.tmp" "$REMOTE_DIR/$LATEST_NAME"
chmod 644 "$REMOTE_DIR/$LATEST_NAME"

# Atomically update the JSON manifest.
mv -f "$REMOTE_DIR/$MANIFEST_NAME.tmp" "$REMOTE_DIR/$MANIFEST_NAME"
chmod 644 "$REMOTE_DIR/$MANIFEST_NAME"

ls -la "$REMOTE_DIR" | grep -E 'connectcomms|^total' || true
'@
  # Save the bash helper as ASCII without trailing newline noise. Avoid
  # Set-Content -Encoding UTF8 because PowerShell 5.x adds a BOM, which
  # `bash` rejects on the very first byte (#! line).
  [System.IO.File]::WriteAllText($helperPath, $helper, (New-Object System.Text.UTF8Encoding($false)))

  # Step A: ensure remote dir.
  Write-Step "Ensure remote download directory"
  & ssh $SshHost ("mkdir -p '{0}' && chmod 755 '{0}'" -f $RemoteDir)
  if ($LASTEXITCODE -ne 0) { Write-Err "Failed to prepare remote directory."; exit 1 }

  # Step B: upload APK as .tmp + manifest as .tmp + helper script.
  Write-Step "Upload APK + manifest"
  $remoteApkTmp      = "{0}:{1}/{2}.tmp" -f $SshHost, $RemoteDir, $versionedName
  $remoteManifestTmp = "{0}:{1}/{2}.tmp" -f $SshHost, $RemoteDir, $manifestName
  $remoteHelper      = "{0}:/tmp/android-publish-promote.sh" -f $SshHost

  & scp -p $ApkPath        $remoteApkTmp
  if ($LASTEXITCODE -ne 0) { Write-Err "scp APK failed."; exit 1 }

  & scp $tmpManifest       $remoteManifestTmp
  if ($LASTEXITCODE -ne 0) { Write-Err "scp manifest failed."; exit 1 }

  & scp $helperPath        $remoteHelper
  if ($LASTEXITCODE -ne 0) { Write-Err "scp helper failed."; exit 1 }

  # Step C: run the promote helper.
  Write-Step "Promote upload"
  & ssh $SshHost ("bash /tmp/android-publish-promote.sh '{0}' '{1}' '{2}' '{3}' && rm -f /tmp/android-publish-promote.sh" -f $RemoteDir, $versionedName, $latestName, $manifestName)
  if ($LASTEXITCODE -ne 0) { Write-Err "Promote step failed on remote host."; exit 1 }
}
finally {
  if ($tmpManifest -and (Test-Path -LiteralPath $tmpManifest)) { Remove-Item -LiteralPath $tmpManifest -Force -ErrorAction SilentlyContinue }
  if ($helperPath -and (Test-Path -LiteralPath $helperPath))   { Remove-Item -LiteralPath $helperPath   -Force -ErrorAction SilentlyContinue }
}

# Step D: smoke-test.
$publicVersionedUrl = "{0}/{1}" -f $PublicBaseUrl, $versionedName
$publicLatestUrl    = "{0}/{1}" -f $PublicBaseUrl, $latestName

if (-not $SkipSmokeTest) {
  Write-Step "Smoke-test public URLs (HEAD)"
  try {
    $r1 = Invoke-WebRequest -Method Head -Uri $publicLatestUrl -MaximumRedirection 0 -ErrorAction Stop -UseBasicParsing
    $ct = $r1.Headers["Content-Type"]
    $cl = $r1.Headers["Content-Length"]
    $cd = $r1.Headers["Content-Disposition"]
    Write-Ok ("HEAD {0} -> {1} {2}" -f $publicLatestUrl, $r1.StatusCode, $r1.StatusDescription)
    Write-Info ("  Content-Type        : {0}" -f $ct)
    Write-Info ("  Content-Length      : {0}" -f $cl)
    Write-Info ("  Content-Disposition : {0}" -f $cd)
  } catch {
    Write-Err ("HEAD failed for {0}" -f $publicLatestUrl)
    Write-Err $_.Exception.Message
  }
  try {
    $r2 = Invoke-WebRequest -Method Head -Uri $publicVersionedUrl -MaximumRedirection 0 -ErrorAction Stop -UseBasicParsing
    Write-Ok ("HEAD {0} -> {1} {2}" -f $publicVersionedUrl, $r2.StatusCode, $r2.StatusDescription)
  } catch {
    Write-Err ("HEAD failed for {0}" -f $publicVersionedUrl)
    Write-Err $_.Exception.Message
  }
}

Write-Step "Done"
Write-Ok ("Latest URL    : {0}" -f $publicLatestUrl)
Write-Ok ("Versioned URL : {0}" -f $publicVersionedUrl)
