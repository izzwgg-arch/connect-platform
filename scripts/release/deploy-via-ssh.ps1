# Full deploy: commit, tag, push, then run deploy-tag.sh on server via SSH.
# Uses DEPLOY_SSH_TARGET (default: 45.14.194.179 from docs). SSH key used from agent or default.
# Run from repo root.
$ErrorActionPreference = "Stop"
$tag = $args[0]
if (-not $tag) { $tag = "v2.0.7" }
$sshTarget = if ($env:DEPLOY_SSH_TARGET) { $env:DEPLOY_SSH_TARGET } else { "45.14.194.179" }
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Push-Location $root

Write-Host "[deploy-via-ssh] tag=$tag sshTarget=$sshTarget"

# 1) Commit if there are changes
$status = git status --porcelain
if ($status) {
  git add -A
  git commit -m "Deploy: KPI today timezone + PBX_TIMEZONE and release script"
  Write-Host "[deploy-via-ssh] committed"
} else {
  Write-Host "[deploy-via-ssh] working tree clean, no commit"
}

# 2) Tag (if not exists)
$tagExists = git rev-parse "refs/tags/$tag" 2>$null
if (-not $tagExists) {
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
$remoteCmd = "cd /opt/connectcomms/app && git fetch --tags && bash scripts/release/deploy-tag.sh $tag"
Write-Host "[deploy-via-ssh] running on $sshTarget : $remoteCmd"
ssh -o ConnectTimeout=15 -o BatchMode=yes $sshTarget $remoteCmd

Pop-Location
Write-Host "[deploy-via-ssh] done"
