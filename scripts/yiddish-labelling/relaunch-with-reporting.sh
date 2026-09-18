#!/usr/bin/env bash
# Wait for the currently-running orchestrator to exit on its STOP file, then
# relaunch it so it picks up the pipeline-status reporting added after it
# started. Its state file means it resumes the batch it already packed rather
# than redoing the work.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
LOG="relaunch.log"
say() { echo "[relaunch $(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

say "waiting for the orchestrator to finish its current step and exit"
# Count the live orchestrate processes via PowerShell: pgrep cannot see Win32
# processes from Git Bash (that mistake aborted a healthy build earlier today).
# ⛔⛔ The filter string is ITSELF on this powershell process's own
# command line, so a naive -match 'orchestrate.ts' ALWAYS matches at least one
# process -- itself -- and the count never reaches 0. That is what happened on
# 2026-09-18: the orchestrator exited 17:15Z, this watcher counted 1 for three
# hours and never relaunched. Split the literal and drop our own PID so the
# count means what it says.
alive() {
  powershell.exe -NoProfile -Command \
    "@(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'orchestrate' + '.ts' -and \$_.ProcessId -ne \$PID -and \$_.Name -notmatch 'powershell' }).Count" 2>/dev/null |
    tr -d '[:space:]'
}
for _ in $(seq 1 480); do   # up to 4 hours; packing a 60h batch is slow on 4 cores
  n="$(alive)"
  [ -n "$n" ] && [ "$n" = "0" ] && break
  sleep 30
done
if [ "$(alive)" != "0" ]; then
  say "ERROR: orchestrator still running after the wait window — NOT relaunching (a second one would double-claim batches)."
  exit 1
fi
say "orchestrator exited"

rm -f STOP
say "STOP cleared; relaunching with reporting"
set -a
# shellcheck disable=SC1091
# The runner's .env lives OUTSIDE the repo (the repo copy of scripts/yiddish-runner
# ships code only, never secrets), so read the installed runner first and fall back
# to a repo-local file. ⛔ Without this the orchestrator starts with an EMPTY
# DATABASE_URL, silently loses its status reporting and cannot import labels back
# — exactly what the 20:31Z relaunch did.
for env_candidate in "$HOME/LoopcomYiddishRunner/.env" "/c/Users/izzyw/LoopcomYiddishRunner/.env" ../yiddish-runner/.env; do
  [ -f "$env_candidate" ] || continue
  DATABASE_URL="$(grep -h '^DATABASE_URL=' "$env_candidate" | cut -d= -f2-)"
  [ -n "$DATABASE_URL" ] && break
done
if [ -z "${DATABASE_URL:-}" ]; then
  say "ERROR: no DATABASE_URL found in any runner .env — refusing to start a blind orchestrator."
  exit 1
fi
export DATABASE_URL
set +a
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1 KAGGLE_USERNAME=izzywein
nohup npx tsx orchestrate.ts --hours 80 --model ivrit-ai/yi-whisper-large-v3-ct2 --confirm \
  >> orchestrate.log 2>&1 &
say "relaunched (pid $!) — resumes from orchestrate-state.json"
