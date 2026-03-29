#requires -Version 5.1
<#
.SYNOPSIS
  Read-only 1-hour observation: VitalPBX json_snapshot (SSH) + Connect admin diagnostics + live combined.

.DESCRIPTION
  - PBX: ssh cursor-audit@<host> json_snapshot (override with PBX_SSH_TARGET).
  - Connect: GET /admin/diagnostics/ari-bridged-active-calls, GET /admin/pbx/live/combined,
    and GET /admin/diagnostics/pbx-cdr-today-kpis (VitalPBX dashboard-equivalent today totals via cdr.list).
  - Refuses to start until Connect responds successfully (no PBX-only runs by accident).

  Setup: copy scripts/pbx-connect-observe.env.example -> scripts/pbx-connect-observe.env
  Or set CONNECT_OBSERVE_API_BASE and CONNECT_OBSERVE_ADMIN_TOKEN in the environment.

.PARAMETER DurationHours
  Default 2 (paired observation standard)

.PARAMETER IntervalSec
  Default 25 (20–30s recommended)
#>

param(
  [string] $ApiBase = "",
  [string] $Token = "",
  [string] $SshTarget = "",
  [int] $DurationHours = 2,
  [int] $IntervalSec = 25,
  [int] $MaxConciseChars = 6000,
  [int] $MaxBridgeChars = 6000
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir "pbx-connect-observe.env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '^\s*#' -or $line -eq "") { return }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $k = $Matches[1]
      $v = $Matches[2].Trim().Trim('"')
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
    }
  }
}

if ([string]::IsNullOrWhiteSpace($ApiBase)) {
  $ApiBase = [Environment]::GetEnvironmentVariable("CONNECT_OBSERVE_API_BASE")
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  $Token = [Environment]::GetEnvironmentVariable("CONNECT_OBSERVE_ADMIN_TOKEN")
}
if ([string]::IsNullOrWhiteSpace($SshTarget)) {
  $SshTarget = [Environment]::GetEnvironmentVariable("PBX_SSH_TARGET")
}
if ([string]::IsNullOrWhiteSpace($SshTarget)) { $SshTarget = "cursor-audit@209.145.60.79" }

function Normalize-ApiBase([string]$u) {
  if ([string]::IsNullOrWhiteSpace($u)) { return "" }
  return $u.Trim().TrimEnd("/")
}

function Normalize-Token([string]$t) {
  if ([string]::IsNullOrWhiteSpace($t)) { return "" }
  $x = $t.Trim()
  if ($x.StartsWith("Bearer ", [StringComparison]::OrdinalIgnoreCase)) { $x = $x.Substring(7).Trim() }
  return $x
}

$ApiBase = Normalize-ApiBase $ApiBase
$Token = Normalize-Token $Token

if ([string]::IsNullOrWhiteSpace($ApiBase) -or [string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "ERROR: CONNECT_OBSERVE_API_BASE and CONNECT_OBSERVE_ADMIN_TOKEN are required." -ForegroundColor Red
  Write-Host "Copy scripts/pbx-connect-observe.env.example to scripts/pbx-connect-observe.env and fill values, or set env vars."
  exit 2
}

function Extract-JsonSnapshotStringField([string]$raw, [string]$fieldName) {
  $pattern = '"' + [regex]::Escape($fieldName) + '"\s*:\s*"((?:[^"\\]|\\.)*)"'
  $m = [regex]::Match($raw, $pattern)
  if (-not $m.Success) { return $null }
  $inner = $m.Groups[1].Value
  return (($inner -replace '\\n', "`n") -replace '\\r', "`r" -replace '\\"', '"' -replace '\\\\', '\')
}

function Last-RegexMatch([string]$text, [string]$pattern) {
  $all = [regex]::Matches($text, $pattern)
  if ($all.Count -eq 0) { return $null }
  return $all[$all.Count - 1].Groups[1].Value
}

function Invoke-ConnectJson([string]$path) {
  $uri = "$ApiBase$path"
  $headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
  try {
    return @{ Ok = $true; Data = (Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 60) }
  } catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = "$msg | $($_.ErrorDetails.Message)" }
    return @{ Ok = $false; Error = $msg }
  }
}

Write-Host "Probe Connect diagnostics + live combined + PBX CDR today KPIs (required before observation)..."
$probeDiag = Invoke-ConnectJson "/admin/diagnostics/ari-bridged-active-calls"
if (-not $probeDiag.Ok) {
  Write-Host "ERROR: Connect diagnostics failed: $($probeDiag.Error)" -ForegroundColor Red
  Write-Host "Check API base URL, super-admin JWT, and API service env (PBX_ARI_USER/PBX_ARI_PASS for diagnostics)."
  exit 3
}
$probeLive = Invoke-ConnectJson "/admin/pbx/live/combined"
if (-not $probeLive.Ok) {
  Write-Host "ERROR: Connect live combined failed: $($probeLive.Error)" -ForegroundColor Red
  exit 4
}
$probePbxCdr = Invoke-ConnectJson "/admin/diagnostics/pbx-cdr-today-kpis"
if (-not $probePbxCdr.Ok) {
  Write-Host "ERROR: PBX CDR today KPI diagnostic failed: $($probePbxCdr.Error)" -ForegroundColor Red
  Write-Host "Deploy API with /admin/diagnostics/pbx-cdr-today-kpis and ensure PBX instance credentials work."
  exit 5
}
Write-Host "Connect OK. finalActiveCalls(diag)=$($probeDiag.Data.finalActiveCalls) totalActiveCalls(live)=$($probeLive.Data.summary.totalActiveCalls)"
Write-Host "PBX dashboard-equiv today: in=$($probePbxCdr.Data.incomingToday) out=$($probePbxCdr.Data.outgoingToday) int=$($probePbxCdr.Data.internalToday) missed=$($probePbxCdr.Data.missedToday) tenantsQueried=$($probePbxCdr.Data.tenantsQueried)"

$logPath = Join-Path $env:TEMP "pbx-connect-observe-$(Get-Date -Format 'yyyyMMdd-HHmmss').ndjson"
$start = Get-Date
$end = $start.AddHours($DurationHours)
$sample = 0

Write-Host "Logging to $logPath"
Write-Host "PBX SSH: $SshTarget json_snapshot | interval ${IntervalSec}s | duration ${DurationHours}h"

while ((Get-Date) -lt $end) {
  $sample++
  $tsUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

  $pbxSnap = ""
  try {
    $pbxSnap = ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=35 $SshTarget json_snapshot 2>&1 | Out-String
  } catch {
    $pbxSnap = "SSH_ERROR: $($_.Exception.Message)"
  }

  $pbxActiveChannels = Last-RegexMatch $pbxSnap '(\d+)\s+active\s+channel'
  $pbxActiveCalls = Last-RegexMatch $pbxSnap '(\d+)\s+active\s+call'
  $conciseFull = Extract-JsonSnapshotStringField $pbxSnap "core_show_channels_concise"
  $bridgeFull = Extract-JsonSnapshotStringField $pbxSnap "bridge_show_all"
  $conciseTrunc = $conciseFull
  $conciseTruncated = $false
  if ($conciseTrunc -and $conciseTrunc.Length -gt $MaxConciseChars) {
    $conciseTrunc = $conciseTrunc.Substring(0, $MaxConciseChars)
    $conciseTruncated = $true
  }
  $bridgeTrunc = $bridgeFull
  $bridgeTruncated = $false
  if ($bridgeTrunc -and $bridgeTrunc.Length -gt $MaxBridgeChars) {
    $bridgeTrunc = $bridgeTrunc.Substring(0, $MaxBridgeChars)
    $bridgeTruncated = $true
  }

  $hints = @{
    hasMessage      = $pbxSnap -match 'Message/'
    hasVoicemail    = $pbxSnap -match 'sub-vm|VoiceMail|voicemail'
    hasIvr          = $pbxSnap -match 'IVR-|app-ivr'
    hasQueue        = $pbxSnap -match 'queue-call-to-agents|_queue|ext-queues'
    hasTrunkDial    = $pbxSnap -match 'trk-[^-]+-dial|default-trunk'
    hasLocalLeg     = $pbxSnap -match 'Local/'
  }

  $diag = Invoke-ConnectJson "/admin/diagnostics/ari-bridged-active-calls"
  $live = Invoke-ConnectJson "/admin/pbx/live/combined"
  $pbxCdrKpi = Invoke-ConnectJson "/admin/diagnostics/pbx-cdr-today-kpis"

  $diagFinal = $null
  $diagBridge = $null
  $diagOrphan = $null
  $diagRawBr = $null
  $diagRawCh = $null
  $diagErr = $null
  $summaryRowsBrief = $null
  if ($diag.Ok -and $diag.Data) {
    $diagFinal = $diag.Data.finalActiveCalls
    $diagBridge = $diag.Data.bridgeBackedCallCount
    $diagOrphan = $diag.Data.orphanLegCallCount
    $diagRawBr = $diag.Data.rawBridgeCount
    $diagRawCh = $diag.Data.rawChannelCount
    if ($diag.Data.summaryRows) {
      $summaryRowsBrief = ($diag.Data.summaryRows | ConvertTo-Json -Depth 6 -Compress)
      if ($summaryRowsBrief.Length -gt 12000) {
        $summaryRowsBrief = $summaryRowsBrief.Substring(0, 12000) + "…"
      }
    }
  } else {
    $diagErr = $diag.Error
  }

  $missedToday = $null
  $incToday = $null
  $outToday = $null
  $intToday = $null
  $liveTotalActive = $null
  $liveListCount = $null
  $liveDirs = @{ incoming = 0; outgoing = 0; internal = 0; other = 0 }
  $liveErr = $null
  $liveRowsBrief = $null
  if ($live.Ok -and $live.Data) {
    $s = $live.Data.summary
    if ($s) {
      $missedToday = $s.missedToday
      $incToday = $s.incomingToday
      $outToday = $s.outgoingToday
      $intToday = $s.internalToday
      $liveTotalActive = $s.totalActiveCalls
    }
    $calls = $live.Data.activeCalls.calls
    if ($calls) {
      $liveListCount = @($calls).Count
      foreach ($c in $calls) {
        $d = [string]$c.direction
        if ($liveDirs.ContainsKey($d)) { $liveDirs[$d]++ } else { $liveDirs["other"]++ }
      }
    } else {
      $liveListCount = 0
    }
    $liveRowsBrief = ($calls | ConvertTo-Json -Depth 5 -Compress)
    if ($liveRowsBrief.Length -gt 12000) { $liveRowsBrief = $liveRowsBrief.Substring(0, 12000) + "…" }
  } else {
    $liveErr = $live.Error
  }

  $pbxCdrInc = $null
  $pbxCdrOut = $null
  $pbxCdrInt = $null
  $pbxCdrMiss = $null
  $pbxCdrTenants = $null
  $pbxCdrErr = $null
  if ($pbxCdrKpi.Ok -and $pbxCdrKpi.Data) {
    $pbxCdrInc = $pbxCdrKpi.Data.incomingToday
    $pbxCdrOut = $pbxCdrKpi.Data.outgoingToday
    $pbxCdrInt = $pbxCdrKpi.Data.internalToday
    $pbxCdrMiss = $pbxCdrKpi.Data.missedToday
    $pbxCdrTenants = $pbxCdrKpi.Data.tenantsQueried
  } else {
    $pbxCdrErr = $pbxCdrKpi.Error
  }

  $offsetDiag = $null
  $matchDiag = $null
  if ($null -ne $pbxActiveCalls -and $null -ne $diagFinal) {
    $offsetDiag = [int]$diagFinal - [int]$pbxActiveCalls
    $matchDiag = ($offsetDiag -eq 0)
  }

  $offsetLiveSummary = $null
  if ($null -ne $pbxActiveCalls -and $null -ne $liveTotalActive) {
    $offsetLiveSummary = [int]$liveTotalActive - [int]$pbxActiveCalls
  }

  $kpiOffIn = $null
  $kpiOffOut = $null
  $kpiOffInt = $null
  $kpiOffMiss = $null
  if ($null -ne $incToday -and $null -ne $pbxCdrInc) { $kpiOffIn = [int]$incToday - [int]$pbxCdrInc }
  if ($null -ne $outToday -and $null -ne $pbxCdrOut) { $kpiOffOut = [int]$outToday - [int]$pbxCdrOut }
  if ($null -ne $intToday -and $null -ne $pbxCdrInt) { $kpiOffInt = [int]$intToday - [int]$pbxCdrInt }
  if ($null -ne $missedToday -and $null -ne $pbxCdrMiss) { $kpiOffMiss = [int]$missedToday - [int]$pbxCdrMiss }

  $rec = [ordered]@{
    sample          = $sample
    timestampUtc    = $tsUtc
    pbx             = [ordered]@{
      activeChannels   = $pbxActiveChannels
      activeCalls      = $pbxActiveCalls
      channelsConcise  = $conciseTrunc
      channelsConciseTruncated = $conciseTruncated
      bridgeShowAll    = $bridgeTrunc
      bridgeShowAllTruncated = $bridgeTruncated
      hints            = $hints
      dashboardCdrToday = [ordered]@{
        incomingToday  = $pbxCdrInc
        outgoingToday  = $pbxCdrOut
        internalToday  = $pbxCdrInt
        missedToday    = $pbxCdrMiss
        tenantsQueried = $pbxCdrTenants
        source         = "pbx"
        error          = $pbxCdrErr
      }
    }
    connect         = [ordered]@{
      diagnostics      = [ordered]@{
        finalActiveCalls     = $diagFinal
        bridgeBackedCallCount = $diagBridge
        orphanLegCallCount   = $diagOrphan
        rawBridgeCount       = $diagRawBr
        rawChannelCount      = $diagRawCh
        error                = $diagErr
        summaryRowsJson      = $summaryRowsBrief
      }
      liveCombined     = [ordered]@{
        totalActiveCalls = $liveTotalActive
        activeListCount  = $liveListCount
        directionCounts  = $liveDirs
        incomingToday    = $incToday
        outgoingToday    = $outToday
        internalToday    = $intToday
        missedToday      = $missedToday
        error            = $liveErr
        activeCallsJson  = $liveRowsBrief
      }
    }
    compare         = [ordered]@{
      offsetDiagVsPbxFooter = $offsetDiag
      matchDiagVsPbxFooter  = $matchDiag
      offsetLiveSummaryVsPbxFooter = $offsetLiveSummary
      connectMinusPbxDashboardCdr = [ordered]@{
        incomingToday = $kpiOffIn
        outgoingToday = $kpiOffOut
        internalToday = $kpiOffInt
        missedToday   = $kpiOffMiss
      }
    }
  }

  ($rec | ConvertTo-Json -Depth 25 -Compress) | Add-Content -Path $logPath -Encoding utf8

  Start-Sleep -Seconds $IntervalSec
}

Write-Host "DONE samples=$sample log=$logPath"
Write-Host "Analyze with: pwsh -File `"$ScriptDir\analyze-pbx-connect-observe.ps1`" -LogPath `"$logPath`""
