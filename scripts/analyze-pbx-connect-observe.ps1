#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string] $LogPath
)

if (-not (Test-Path $LogPath)) { Write-Error "Log not found: $LogPath"; exit 1 }

$rows = @()
Get-Content $LogPath -Encoding utf8 | ForEach-Object {
  if ([string]::IsNullOrWhiteSpace($_)) { return }
  try { $rows += (ConvertFrom-Json $_) } catch { }
}

$n = $rows.Count
$matched = 0
$mismatched = 0
$offsets = @()
$mismatchSamples = @()

foreach ($r in $rows) {
  $pbx = [int]$r.pbx.activeCalls
  $cf = $r.connect.diagnostics.finalActiveCalls
  if ($null -eq $cf) { continue }
  $c = [int]$cf
  $off = $c - $pbx
  $offsets += $off
  if ($off -eq 0) { $matched++ } else { $mismatched++; $mismatchSamples += [ordered]@{ ts = $r.timestampUtc; pbx = $pbx; connect = $c; off = $off } }
}

$avg = if ($offsets.Count) { ($offsets | Measure-Object -Average).Average } else { $null }
$maxP = if ($offsets.Count) { ($offsets | Measure-Object -Maximum).Maximum } else { $null }
$maxN = if ($offsets.Count) { ($offsets | Measure-Object -Minimum).Minimum } else { $null }
$compared = $matched + $mismatched
$pct = if ($compared -gt 0) { [math]::Round(100.0 * $matched / $compared, 2) } else { $null }

Write-Host "=== SECTION 1 (log file) ==="
Write-Host "LogPath: $LogPath"
Write-Host "Lines parsed: $($rows.Count)"
Write-Host ""

Write-Host "=== SECTION 2 (diag finalActiveCalls vs PBX footer active calls) ==="
Write-Host "Compared samples: $compared"
Write-Host "Matched: $matched"
Write-Host "Mismatched: $mismatched"
Write-Host "Match %: $pct"
Write-Host "Avg offset (Connect - PBX): $avg"
Write-Host "Max Connect higher: $maxP"
Write-Host "Max Connect lower: $maxN"
Write-Host ""

Write-Host "=== Mismatch timeline (first 40) ==="
$mismatchSamples | Select-Object -First 40 | Format-Table -AutoSize

# --- Scenario hints (PBX side) ---
$idle = ($rows | Where-Object { [int]$_.pbx.activeCalls -eq 0 }).Count
$q = ($rows | Where-Object { $_.pbx.hints.hasQueue -eq $true }).Count
$ivr = ($rows | Where-Object { $_.pbx.hints.hasIvr -eq $true }).Count
$vm = ($rows | Where-Object { $_.pbx.hints.hasVoicemail -eq $true }).Count
$tr = ($rows | Where-Object { $_.pbx.hints.hasTrunkDial -eq $true }).Count
$msg = ($rows | Where-Object { $_.pbx.hints.hasMessage -eq $true }).Count

Write-Host ""
Write-Host "=== SECTION 3 (PBX hint hit counts — samples where hint true) ==="
Write-Host "Idle (pbx activeCalls=0): $idle"
Write-Host "Queue hint: $q | IVR hint: $ivr | Voicemail hint: $vm | Trunk-dial hint: $tr | Message/* in snapshot: $msg"

# --- Connect live KPI vs VitalPBX dashboard CDR totals (same log line) ---
$kpiRows = @($rows | Where-Object { $null -ne $_.compare.connectMinusPbxDashboardCdr.outgoingToday })
if ($kpiRows.Count -gt 0) {
  $first = $kpiRows[0]
  $last = $kpiRows[$kpiRows.Count - 1]
  Write-Host ""
  Write-Host "=== SECTION 4 (ConnectCdr live KPI vs PBX cdr.list today — first/last sample) ==="
  Write-Host "Samples with KPI compare: $($kpiRows.Count)"
  Write-Host "First: $($first.timestampUtc) Connect out=$($first.connect.liveCombined.outgoingToday) PBX out=$($first.pbx.dashboardCdrToday.outgoingToday) delta=$($first.compare.connectMinusPbxDashboardCdr.outgoingToday)"
  Write-Host "Last:  $($last.timestampUtc) Connect out=$($last.connect.liveCombined.outgoingToday) PBX out=$($last.pbx.dashboardCdrToday.outgoingToday) delta=$($last.compare.connectMinusPbxDashboardCdr.outgoingToday)"
}
