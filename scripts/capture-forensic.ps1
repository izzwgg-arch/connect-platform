# Capture same-moment forensic + diagnostics from telephony service.
# Usage:
#   $env:TELEPHONY_URL = "http://your-telephony:3003"  # optional; default localhost:3003
#   .\scripts\capture-forensic.ps1
#   # Optionally run PBX snapshot in parallel: ssh cursor-audit@209.145.60.79 json_snapshot > pbx_snapshot_forensic.json
#
# Writes: forensic_capture.json, diagnostics_capture.json in repo root.

$ErrorActionPreference = "Stop"
$base = if ($env:TELEPHONY_URL) { $env:TELEPHONY_URL.TrimEnd("/") } else { "http://localhost:3003" }
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path $root)) { $root = (Get-Location).Path }

$forensicUrl = "${base}/forensic?pbx=1&kpi=6&rows=6"
$diagUrl = "${base}/diagnostics"

Write-Host "Fetching forensic from $forensicUrl ..."
$forensic = Invoke-RestMethod -Uri $forensicUrl -TimeoutSec 15
$forensic | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $root "forensic_capture.json") -Encoding utf8
Write-Host "Wrote forensic_capture.json"

Write-Host "Fetching diagnostics from $diagUrl ..."
$diag = Invoke-RestMethod -Uri $diagUrl -TimeoutSec 10
$diag | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $root "diagnostics_capture.json") -Encoding utf8
Write-Host "Wrote diagnostics_capture.json"

Write-Host "derivedActiveCount = $($forensic.forensic.derivedActiveCount)"
Write-Host "bucketCounts = $($forensic.forensic.bucketCounts | ConvertTo-Json -Compress)"
