#!/usr/bin/env bash
# Push the training kernel as soon as a free-tier GPU slot opens.
#
# ⛔ Kaggle's free tier allows TWO concurrent batch GPU sessions. The labelling
# kernel holds one, and a just-failed training session keeps its slot for a few
# minutes after the run itself has died -- so a push right after a failure is
# refused with "Maximum batch GPU session count of 2 reached", which
# `kaggle kernels push` reports on stdout WITH A ZERO EXIT CODE. kaggle-run.ts
# throws on that now (assertKernelActuallyStarted), which is what makes this
# loop able to tell "refused" from "started".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
LOG="$HERE/retry-training-push.log"
export PATH="/c/Users/izzyw/LoopcomYiddishRunner/.venv/Scripts:$PATH"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1 KAGGLE_USERNAME=izzywein
say() { echo "[retry-push $(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

ATTEMPTS="${1:-40}"     # 40 x 3 min = 2 hours
for i in $(seq 1 "$ATTEMPTS"); do
  if npx tsx scripts/yiddish-finetune/kaggle-run.ts kernel-push --confirm --owner izzywein >>"$LOG" 2>&1; then
    say "kernel push ACCEPTED on attempt $i — training run started"
    npx tsx scripts/yiddish-finetune/report-state.ts --key training.run.v1 --kind training \
      --status running --headline "Training kernel started on Kaggle (attempt $i, after waiting for a free GPU slot)." >>"$LOG" 2>&1 || true
    exit 0
  fi
  say "attempt $i refused (no free GPU slot yet); waiting 3 min"
  sleep 180
done
say "ERROR: never got a free GPU slot after $ATTEMPTS attempts."
npx tsx scripts/yiddish-finetune/report-state.ts --key training.run.v1 --kind training \
  --status error --headline "Could not start training: both free Kaggle GPU slots stayed busy." >>"$LOG" 2>&1 || true
exit 1
