# Install the support-ticket watcher as a logon task, plus its watchdog.
#
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Remove
#
# Registers TWO tasks:
#   1. "Loopcom support ticket watcher"  - run-watcher.cmd, launched HIDDEN via
#      run-watcher-hidden.vbs. Hidden on purpose: on 2026-08-31 a Ctrl+C in the
#      watcher's console killed the watcher AND the restart wrapper, and it sat
#      dead for 18 hours. With no window there is nothing to close by accident.
#   2. "Loopcom support watcher watchdog" - watchdog.mjs every 10 minutes, which
#      restarts task 1 when the heartbeat goes stale. The server-side guardrail
#      (supportLoopGuardrail.ts) is the alarm of last resort beyond both.
#
# NOTE: this file is deliberately PURE ASCII. Windows PowerShell 5.1 reads a
# BOM-less script as ANSI, so a single non-ASCII character (an em-dash, or one
# of the stop signs this repo uses everywhere) is decoded as two bytes and the
# parser dies with "the string is missing the terminator" pointing at an
# unrelated line. Keep it ASCII.
#
# WARNING: deliberately NOT a Windows service. A service runs as SYSTEM, and the
# watcher needs the SIGNED-IN user's Claude credentials and ~/.claude.json to
# spawn an agent at all. As SYSTEM it would start cleanly and then fail every
# single run with "Not logged in", which reads like a broken agent rather than a
# wrong account.

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$TaskName     = "Loopcom support ticket watcher"
$WatchdogName = "Loopcom support watcher watchdog"
$Here         = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cmd          = Join-Path $Here "run-watcher.cmd"
$Vbs          = Join-Path $Here "run-watcher-hidden.vbs"
$Watchdog     = Join-Path $Here "watchdog.mjs"

if ($Remove) {
  foreach ($name in @($TaskName, $WatchdogName)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "Removed '$name'."
    } else {
      Write-Host "'$name' was not installed."
    }
  }
  return
}

if (-not (Test-Path $Cmd))      { throw "Cannot find $Cmd" }
if (-not (Test-Path $Vbs))      { throw "Cannot find $Vbs" }
if (-not (Test-Path $Watchdog)) { throw "Cannot find $Watchdog" }

# ---- 1. the watcher, hidden ------------------------------------------------

$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$Vbs`"" -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RunOnlyIfNetworkAvailable is left off on purpose: the poll retries by itself,
# and a watcher that refuses to start on a slow network start-up is worse than
# one that starts and logs a couple of failed polls.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Starts a Claude agent on each new LoopCom support ticket. Runs hidden; watch it from logs\watcher.log or the Agent runs tab." | Out-Null

# ---- 2. the watchdog, every 10 minutes -------------------------------------

# cmd /c so the watchdog's own output lands in a log rather than nowhere.
$wdArg    = "/c node `"$Watchdog`" >> `"$Here\logs\watchdog.log`" 2>&1"
$wdAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wdArg -WorkingDirectory $Here

# Once-now with a decade of repetition keeps firing every 10 minutes across
# reboots (StartWhenAvailable catches missed starts). NOT [TimeSpan]::MaxValue:
# Windows PowerShell 5.1 serialises that as P99999999DT23H59M59S and the task
# XML validator rejects it - the watchdog silently never registers.
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)

$wdSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $WatchdogName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $WatchdogName -Confirm:$false
}
Register-ScheduledTask -TaskName $WatchdogName -Action $wdAction -Trigger $wdTrigger `
  -Settings $wdSettings -Description "Restarts the Loopcom support ticket watcher when its heartbeat goes stale." | Out-Null

Write-Host "Installed '$TaskName' (hidden, starts at logon for $env:USERNAME)"
Write-Host "Installed '$WatchdogName' (every 10 minutes)"
Write-Host ""
Write-Host "  Start it now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Is it alive:   node status.mjs"
Write-Host "  Its log:       logs\watcher.log   (watchdog: logs\watchdog.log)"
Write-Host "  Remove both:   powershell -File install-task.ps1 -Remove"
