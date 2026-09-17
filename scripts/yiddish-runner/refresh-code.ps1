# Refresh the PC runner's engine snapshot from a repo checkout, then regenerate the
# Prisma client the runner uses. Run from PowerShell on Izzy's PC.
#
#   powershell -File scripts\yiddish-runner\refresh-code.ps1 -Repo "C:\dev\projects\yc-build-wt"
#
# The runner runs the SAME stage code as production: code\apps\api\src\yiddishCorpus is a
# verbatim copy, and code\packages\db\prisma\schema.prisma drives `prisma generate`.
# After a schema change (new columns), this MUST run or the runner's client will not
# know the new fields and every write will fail.
param(
  [string]$Repo = "C:\dev\projects\Connect 2",
  [string]$Runner = "C:\Users\izzyw\LoopcomYiddishRunner"
)
$ErrorActionPreference = "Stop"
$src = Join-Path $Repo "apps\api\src\yiddishCorpus"
$dst = Join-Path $Runner "code\apps\api\src\yiddishCorpus"
if (-not (Test-Path $src)) { throw "engine source not found: $src" }
New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
# /MIR mirrors deletions too, so a removed file does not linger in the snapshot.
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /XD fixtures | Out-Null
robocopy (Join-Path $src "fixtures") (Join-Path $dst "fixtures") /MIR /NFL /NDL /NJH /NJS | Out-Null
$schemaSrc = Join-Path $Repo "packages\db\prisma\schema.prisma"
$schemaDst = Join-Path $Runner "code\packages\db\prisma\schema.prisma"
New-Item -ItemType Directory -Force (Split-Path $schemaDst) | Out-Null
Copy-Item $schemaSrc $schemaDst -Force
# Copy the runner-side scripts that live in the repo too.
foreach ($f in @("runner.ts","copy-call-recordings.ts","languageProbe.ts","push-gold-clips.ts")) {
  $p = Join-Path $Repo "scripts\yiddish-runner\$f"
  if (Test-Path $p) { Copy-Item $p (Join-Path $Runner $f) -Force }
}
Push-Location $Runner
try {
  & "$Runner\node_modules\.bin\prisma.cmd" generate --schema "code\packages\db\prisma\schema.prisma" | Select-Object -Last 3
} finally { Pop-Location }
Write-Host "refreshed engine snapshot from $Repo and regenerated the Prisma client."
Write-Host "Restart the runner: create STOP in $Runner, wait for the window to exit, then run start.cmd (or sign out/in)."
