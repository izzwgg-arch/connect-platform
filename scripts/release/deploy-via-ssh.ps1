# Full deploy: commit, tag, push, then run deploy-tag.sh on server via SSH.
# DEPLOY_SSH_TARGET default: root@45.14.194.179. DEPLOY_SSH_KEY default: $env:USERPROFILE\.ssh\connect_ed25519
# Usage: powershell -ExecutionPolicy Bypass -File scripts/release/deploy-via-ssh.ps1 [tag]
$ErrorActionPreference = "Stop"
$tag = $args[0]
if (-not $tag) { $tag = "v2.0.7" }
$sshTarget = if ($env:DEPLOY_SSH_TARGET) { $env:DEPLOY_SSH_TARGET } else { "root@45.14.194.179" }
$sshKey = if ($env:DEPLOY_SSH_KEY) { $env:DEPLOY_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\connect_ed25519" }
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Push-Location $root

Write-Host "[deploy-via-ssh] tag=$tag sshTarget=$sshTarget key=$sshKey"

# 1) Commit if there are changes
$status = git status --porcelain
if ($status) {
  git add -A
  git commit -m "Deploy: release $tag"
  Write-Host "[deploy-via-ssh] committed"
} else {
  Write-Host "[deploy-via-ssh] working tree clean, no commit"
}

# 2) Tag (if not exists) — git rev-parse writes to stderr when missing; avoid terminating the script on that.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$null = git rev-parse "refs/tags/$tag" 2>&1
$revParseExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($revParseExit -ne 0) {
  git tag $tag
  Write-Host "[deploy-via-ssh] tagged $tag"
} else {
  Write-Host "[deploy-via-ssh] tag $tag already exists"
}

# 3) Push branch and tag
git push origin HEAD
git push origin $tag
Write-Host "[deploy-via-ssh] pushed"

# 4) Run deploy on server
$remoteCmd = "cd /opt/connectcomms/app && git fetch --tags && git reset --hard refs/tags/$tag && git clean -fd && git checkout --detach refs/tags/$tag && bash scripts/release/deploy-tag.sh $tag"
Write-Host "[deploy-via-ssh] running on $sshTarget : $remoteCmd"
$sshArgs = @("-o", "ConnectTimeout=15", "-o", "BatchMode=yes")
if (Test-Path -LiteralPath $sshKey) { $sshArgs += @("-i", $sshKey) }
& ssh @sshArgs $sshTarget $remoteCmd

Pop-Location
Write-Host "[deploy-via-ssh] done"
