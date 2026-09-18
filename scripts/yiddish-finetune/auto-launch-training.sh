#!/usr/bin/env bash
# Wait for build-dataset to finish cutting clips, then push the dataset to a
# PRIVATE Kaggle dataset and start the fine-tune kernel on the free GPUs.
#
# Run from the repo root of the build worktree:
#   bash scripts/yiddish-finetune/auto-launch-training.sh v1
#
# Why a script: the clip cut takes hours on this box, and the owner asked for
# training to start without further hand-holding. This turns "wait then launch"
# into one unattended step that logs what it did.
set -uo pipefail
VERSION="${1:-v1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DS="scripts/yiddish-finetune/dataset/$VERSION"
LOG="scripts/yiddish-finetune/auto-launch-$VERSION.log"

export PATH="/c/Users/izzyw/LoopcomYiddishRunner/.venv/Scripts:$PATH"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1 KAGGLE_USERNAME=izzywein
say() { echo "[auto-launch $(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

say "waiting for $DS/manifest.json (build-dataset still cutting clips)"
# manifest.json is written LAST by build-dataset, so its presence means done.
# ⛔ Do NOT use pgrep to decide whether the builder is alive: this is Git Bash on
# Windows and pgrep cannot see Win32 processes, so it reports "gone" instantly
# and aborts a perfectly healthy 4-hour build. Watch actual PROGRESS instead —
# the clip count. Stall = no new clip for STALL_LIMIT consecutive checks.
STALL_LIMIT=20   # 20 x 60 s = 20 minutes with no new clip
stall=0
last=-1
while [ ! -f "$DS/manifest.json" ]; do
  now=$(ls "$DS/clips" 2>/dev/null | wc -l)
  if [ "$now" -eq "$last" ]; then
    stall=$((stall + 1))
    if [ "$stall" -ge "$STALL_LIMIT" ]; then
      say "ERROR: clip count stuck at $now for $STALL_LIMIT minutes and no manifest — aborting."
      exit 1
    fi
  else
    [ $((now % 500)) -lt 50 ] && say "cutting clips: $now"
    stall=0
  fi
  last="$now"
  sleep 60
done
CLIPS=$(ls "$DS/clips" 2>/dev/null | wc -l)
say "dataset ready: $CLIPS clip file(s)"

say "pushing private Kaggle dataset (FLAC to halve the upload)"
if ! npx tsx scripts/yiddish-finetune/kaggle-run.ts dataset-push --dataset "$DS" --flac --new --confirm --owner izzywein >>"$LOG" 2>&1; then
  say "ERROR: dataset-push failed — see $LOG"
  exit 1
fi
say "dataset pushed"

say "pushing + starting the training kernel (free GPU)"
if ! npx tsx scripts/yiddish-finetune/kaggle-run.ts kernel-push --confirm --owner izzywein >>"$LOG" 2>&1; then
  say "ERROR: kernel-push failed — see $LOG"
  exit 1
fi
say "TRAINING STARTED — poll with: kaggle-run.ts status --confirm --owner izzywein"
