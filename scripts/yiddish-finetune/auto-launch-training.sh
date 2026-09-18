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
PIPELINE_KEY="training.run.$VERSION"

export PATH="/c/Users/izzyw/LoopcomYiddishRunner/.venv/Scripts:$PATH"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1 KAGGLE_USERNAME=izzywein
say() { echo "[auto-launch $(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# Best-effort live status for the portal (YcPipelineState). NEVER allowed to
# abort this script: report-state.ts itself never throws on a DB/table
# failure, and this wrapper also never lets a bad call trip `set -e`-style
# failure (there is none here, but `run_report` is still defensive) — a
# status write is not load-bearing for the actual training run.
run_report() {
  npx tsx scripts/yiddish-finetune/report-state.ts --key "$PIPELINE_KEY" --kind training "$@" >>"$LOG" 2>&1 || true
}

run_report --status running --headline "Waiting for dataset $VERSION's clips to finish cutting."

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
      run_report --status error --headline "Dataset $VERSION stalled: clip count stuck at $now for $STALL_LIMIT minutes, no manifest." \
        --detail-json "{\"clipCount\":$now,\"stallLimitMinutes\":$STALL_LIMIT}"
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
run_report --status running --headline "Uploading dataset $VERSION to Kaggle ($CLIPS clip file(s), FLAC)." --detail-json "{\"clips\":$CLIPS}"
if ! npx tsx scripts/yiddish-finetune/kaggle-run.ts dataset-push --dataset "$DS" --flac --new --confirm --owner izzywein >>"$LOG" 2>&1; then
  say "ERROR: dataset-push failed — see $LOG"
  run_report --status error --headline "Dataset $VERSION upload to Kaggle failed." --detail-json "{\"reason\":\"dataset-push failed, see $LOG\"}"
  exit 1
fi
say "dataset pushed"

KERNEL_REF="izzywein/loopcom-yiddish-whisper-finetune"
say "pushing + starting the training kernel (free GPU)"
if ! npx tsx scripts/yiddish-finetune/kaggle-run.ts kernel-push --confirm --owner izzywein >>"$LOG" 2>&1; then
  say "ERROR: kernel-push failed — see $LOG"
  run_report --status error --headline "Training kernel push for dataset $VERSION failed." \
    --detail-json "{\"kernelRef\":\"$KERNEL_REF\",\"reason\":\"kernel-push failed, see $LOG\"}"
  exit 1
fi
say "TRAINING STARTED — poll with: kaggle-run.ts status --confirm --owner izzywein"
run_report --status running --headline "Training kernel running on Kaggle for dataset $VERSION." --detail-json "{\"kernelRef\":\"$KERNEL_REF\"}"
