# Install the support-ticket watcher as a logon task.
#
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Remove
#
# Registers run-watcher.cmd to start at logon, and to keep running.
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
$TaskName = "Loopcom support ticket watcher"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cmd      = Join-Path $Here "run-watcher.cmd"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed '$TaskName'. The watcher will not start at logon any more."
  } else {
    Write-Host "'$TaskName' was not installed."
  }
  return
}

if (-not (Test-Path $Cmd)) { throw "Cannot find $Cmd" }

$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Cmd`"" -WorkingDirectory $Here
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
  -Settings $settings -Description "Starts a Claude agent on each new LoopCom support ticket." | Out-Null

Write-Host "Installed '$TaskName' - starts at logon for $env:USERNAME."
Write-Host ""
Write-Host "  Start it now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Is it alive:   node status.mjs"
Write-Host "  Its log:       logs\watcher.log"
Write-Host "  Remove it:     powershell -File install-task.ps1 -Remove"
