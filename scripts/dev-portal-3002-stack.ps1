# Local portal on :3002 with API on :3011 (matches apps/portal/.env.local PORTAL_API_DEV_PROXY).
#
# Usage (repo root):
#   pnpm dev:portal3002
#
# Opens:
#   Portal  http://localhost:3002
#   Server Health  http://localhost:3002/admin/server-health
#   Login  http://localhost:3002/login  (Local dev sign-in: imwog@gmail.com / LocalDev2026!)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Test-PortListening([int]$Port) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

Write-Host ""
Write-Host "Connect local dev (portal :3002, API :3011)"
Write-Host "  Portal        http://localhost:3002"
Write-Host "  Server Health http://localhost:3002/admin/server-health"
Write-Host "  Login         http://localhost:3002/login"
Write-Host ""

if (-not (Test-PortListening 3011)) {
  Write-Host "[dev] Starting API on port 3011..."
  Start-Process powershell -WorkingDirectory (Join-Path $root "apps\api") -ArgumentList @(
    "-NoExit", "-Command", "`$env:PORT='3011'; pnpm dev"
  )
} else {
  Write-Host "[dev] API already responding on :3011"
}

if (-not (Test-PortListening 3002)) {
  Write-Host "[dev] Starting portal on port 3002..."
  Start-Process powershell -WorkingDirectory $root -ArgumentList @(
    "-NoExit", "-Command", "pnpm portal:dev:3002"
  )
} else {
  Write-Host "[dev] Portal already responding on :3002"
}

Write-Host ""
Write-Host "Wait for both terminals to show ready, then open Server Health (sign in with Local dev sign-in if needed)."
Write-Host ""
