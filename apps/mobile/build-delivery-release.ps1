# Connect Delivery — one-shot build + verify + Desktop handoff (run on a machine that has
# JDK 17+, Android SDK/NDK, and network to your DB). This does NOT deploy. It builds & verifies.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps/mobile/build-delivery-release.ps1
#
# Prereqs it checks: java, Android SDK, node, pnpm (installs pnpm via corepack if missing).
# Requires DATABASE_URL (local/staging) and EXPO_PUBLIC_API_BASE_URL set in your env.

param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$Version  = "1.0.0",
  [string]$Rc       = "rc1"
)
$ErrorActionPreference = "Stop"
function Step($m){ Write-Host "`n==== $m ====" -ForegroundColor Cyan }
function Fail($m){ Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }
function Ok($m){ Write-Host "  [ok] $m" -ForegroundColor Green }

Set-Location $RepoRoot
Write-Host "Repo: $RepoRoot" -ForegroundColor White

# 0. Prereqs -------------------------------------------------------------------
Step "Checking prerequisites"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node not found" }
if (-not (Get-Command java -ErrorAction SilentlyContinue) -and -not $env:JAVA_HOME) { Fail "Java (JDK 17+) not found — install it or set JAVA_HOME" }
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) { Fail "Android SDK not found — set ANDROID_HOME (install via Android Studio)" }
if (-not $env:DATABASE_URL) { Fail "DATABASE_URL not set — point it at a LOCAL/STAGING Postgres (never prod)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "  pnpm missing — enabling via corepack" -ForegroundColor Yellow
  corepack enable; corepack prepare pnpm@10.30.2 --activate
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail "could not install pnpm — run 'npm i -g pnpm@10.30.2'" }
}
Ok "prereqs present"

# 1. Install + DB migrate/generate --------------------------------------------
Step "pnpm install"; pnpm install; if ($LASTEXITCODE) { Fail "pnpm install" }
Step "prisma migrate dev + generate (local/staging)"
pnpm --filter '@connect/db' exec prisma migrate dev --name delivery_core
if ($LASTEXITCODE) { Fail "prisma migrate dev — check DATABASE_URL / Node version (Prisma 6.19 dislikes Node 26)" }
Ok "migration applied + client generated"

# 2. Typecheck / build packages -----------------------------------------------
Step "Build @connect/shared, @connect/api, @connect/portal"
pnpm --filter '@connect/shared' build; if ($LASTEXITCODE) { Fail "shared build" }
pnpm --filter '@connect/api' build;    if ($LASTEXITCODE) { Fail "api build (delivery routes / prisma client)" }
pnpm --filter '@connect/portal' build; if ($LASTEXITCODE) { Fail "portal build (Tracking pages/nav/permissions)" }
Ok "packages build clean"

# 3. Delivery tests ------------------------------------------------------------
Step "Delivery unit tests"
node --import tsx --test "apps/api/src/delivery/*.test.ts" "apps/mobile/src/delivery/*.test.ts"
if ($LASTEXITCODE) { Fail "unit tests" }
Ok "unit tests pass"

# 4. Build the release APK -----------------------------------------------------
Step "Building Android release APK"
pnpm mobile:build:android:release
if ($LASTEXITCODE) { Fail "APK build (assembleRelease)" }
$apk = Get-ChildItem "apps/mobile/android/app/build/outputs/apk/release/app-release.apk" -ErrorAction SilentlyContinue
if (-not $apk) { $apk = Get-ChildItem "apps/mobile/dist/connect-android-release-*.apk" | Sort-Object LastWriteTime | Select-Object -Last 1 }
if (-not $apk) { Fail "APK not found after build" }
Ok "APK: $($apk.FullName)"

# 5. Verify (checksum + quick secret scan) ------------------------------------
Step "Verifying artifact"
$sha = (Get-FileHash $apk.FullName -Algorithm SHA256).Hash
Ok "sha256: $sha"
Write-Host "  (manually run apksigner verify to confirm it's release-signed, and scan the bundle for secrets — see DELIVERY_APK_HANDOFF.md §4)" -ForegroundColor Yellow

# 6. Desktop handoff ----------------------------------------------------------
Step "Desktop handoff"
$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) "Connect Delivery Tracking - APK"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$apkName = "connect-delivery-driver-v$Version-$Rc.apk"
Copy-Item $apk.FullName (Join-Path $dest $apkName) -Force
Set-Content (Join-Path $dest "CHECKSUM.txt") "sha256  $sha  $apkName" -Encoding utf8
Copy-Item "apps/mobile/DELIVERY_APK_HANDOFF.md" (Join-Path $dest "HANDOFF.md") -Force
Set-Content (Join-Path $dest "RELEASE-NOTES.md") "Connect Delivery Driver v$Version-$Rc`nBranch: feature/supermarket-delivery-tracking`nBuilt: (fill date)`nSee HANDOFF.md for install, config, and known limitations." -Encoding utf8
Ok "Desktop folder: $dest"

Write-Host "`nDONE. APK at: $(Join-Path $dest $apkName)" -ForegroundColor Green
Write-Host "sha256: $sha" -ForegroundColor Green
Write-Host "Deploy the server side separately — see apps/api/src/delivery/DELIVERY_DEPLOY.md`n" -ForegroundColor White
