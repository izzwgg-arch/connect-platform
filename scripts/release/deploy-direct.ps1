# SSH wrapper: run scripts/deploy-direct.sh on the Connect app host.
# Push your branch/commit to origin before running.
#
# Usage:
#   pwsh -File scripts/release/deploy-direct.ps1 -Service api -Branch main
#   pwsh -File scripts/release/deploy-direct.ps1 -Service portal -CommitHash abc123 -DryRun
#
# Env: DEPLOY_SSH_TARGET (default connect), DEPLOY_SSH_KEY (optional)
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("api", "portal")]
  [string] $Service,

  [string] $Branch = "",
  [string] $CommitHash = "",
  [switch] $DryRun,
  [switch] $SkipQueueCheck
)

$ErrorActionPreference = "Stop"

if (-not $Branch -and -not $CommitHash) {
  throw "Pass -Branch or -CommitHash"
}
if ($Branch -and $CommitHash) {
  throw "Pass only one of -Branch or -CommitHash"
}

$sshTarget = if ($env:DEPLOY_SSH_TARGET) { $env:DEPLOY_SSH_TARGET } else { "connect" }
$sshKey = if ($env:DEPLOY_SSH_KEY) { $env:DEPLOY_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\connect_ed25519" }

$remoteParts = @("cd /opt/connectcomms/app", "git fetch origin --prune", "bash scripts/deploy-direct.sh $Service")
if ($Branch) { $remoteParts += "--branch"; $remoteParts += $Branch }
if ($CommitHash) { $remoteParts += "--commit"; $remoteParts += $CommitHash }
if ($DryRun) { $remoteParts += "--dry-run" }
if ($SkipQueueCheck) { $remoteParts += "--skip-queue-check" }
$remoteCmd = ($remoteParts -join " ")

$sshArgs = @("-o", "ConnectTimeout=20", "-o", "BatchMode=yes")
if (Test-Path -LiteralPath $sshKey) { $sshArgs += @("-i", $sshKey) }

Write-Host "[deploy-direct] service=$Service sshTarget=$sshTarget"
Write-Host "[deploy-direct] remote: $remoteCmd"
& ssh @sshArgs $sshTarget $remoteCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
