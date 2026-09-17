# Loopcom Yiddish Whisper fine-tune (Lane B)

Builds a training dataset from the Yiddish Learning Engine's own transcripts,
fine-tunes `ivrit-ai/yi-whisper-large-v3-turbo` on a GPU, and points a RunPod
serverless endpoint at the result — the same kind of endpoint the platform's
Everett client (`apps/agent/src/transcription/everett.ts`) already calls in
production.

Full design: `docs/ai-context/AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md`
§3.2. This folder implements Lane B only — the dataset builder runs on Izzy's
PC (Node/tsx), training runs on a GPU that isn't Izzy's PC (Python), nothing
here talks to Yiddish Labs, ever.

**Owner decision 2026-09-17: "use the best free option available"; paid
training cap is $10/day.** So there are TWO training paths, and the FREE one
is the one to reach for first:

| Path | Cost | GPU | Session limit | Script |
|---|---|---|---|---|
| **Kaggle (free)** | $0 | 2x T4 or 1x P100 | 12h/session, ~30 GPU-h/week | `kaggle-run.ts` |
| **RunPod (paid, cheap by default)** | ≤ $10 hard cap by default | cheap consumer cards first (RTX 4090/3090/A5000), A100/H100 only as fallback | `--max-hours` (default 2h) | `runpod-pod.ts` |

Use Kaggle until its weekly free quota is spent, or when a run needs more
than 12h in one session / doesn't fit a T4's 16GB; fall back to RunPod
otherwise. Both paths run the exact same `train.py`, whose defaults are now
sized for a 16GB card either way.

## Where things run

| Script | Runs on | Needs |
|---|---|---|
| `build-dataset.ts` | Izzy's PC | Node 24 + `tsx`, DB tunnel |
| `kaggle-run.ts` | Izzy's PC | the `kaggle` CLI (`pip install kaggle`), `~/.kaggle/kaggle.json` |
| `kaggle_train.ipynb` | a free Kaggle GPU session | pushed by `kaggle-run.ts kernel-push` |
| `runpod-pod.ts` | Izzy's PC | `RUNPOD_API_KEY`, `ssh`/`scp` |
| `runpod-endpoint.ts` | Izzy's PC | `RUNPOD_API_KEY` |
| `smoke-transcribe.ts` | Izzy's PC | `RUNPOD_API_KEY`, an endpoint id |
| `train.py` / `baseline.py` | the rented pod OR the Kaggle kernel | GPU, `requirements.txt` (pod) / `requirements-kaggle.txt` (Kaggle — torch already present) |

## Env vars

- `DATABASE_URL` — loaded automatically from `../yiddish-runner/.env` (same
  manual parser the PC runner uses), through the runner's SSH tunnel to
  Postgres. Never hardcode it here.
- `YC_ENGINE_ROOT` — where `governance.ts` lives, so `build-dataset.ts` calls
  the REAL `trainingEligibilityOf` instead of a re-implementation. Defaults
  to `../../apps/api/src/yiddishCorpus` (this monorepo checkout); on Izzy's
  PC standalone runner folder this should point at the runner's `code/`
  snapshot instead, e.g. `set YC_ENGINE_ROOT=..\yiddish-runner\code\apps\api\src\yiddishCorpus`.
- `YC_FFMPEG_PATH` / `YC_FFPROBE_PATH` — default to the same WinGet ffmpeg
  install path `runner.ts` uses; override if ffmpeg lives elsewhere.
- `RUNPOD_API_KEY` — the agent secret `ivrit_api_key` (see
  `apps/agent/src/secrets/store.ts`). Same key that already pays for Everett.
  Only needed for the paid path (`runpod-pod.ts`, `runpod-endpoint.ts`,
  `smoke-transcribe.ts`).
- `HF_TOKEN` — optional, only needed for `train.py --push-to-hub`.
- `EVERETT_ENDPOINT_ID` / `EVERETT_MODEL` — read by `smoke-transcribe.ts` if
  you don't pass `--endpoint`/`--model` explicitly. Not set anywhere on the
  server today (per the handoff) — `runpod-endpoint.ts create` is what
  produces the first one.
- `KAGGLE_USERNAME` — Izzy's Kaggle username (NOT a secret — it's public,
  just needed to build the `owner/slug` ids Kaggle's API wants). Only needed
  for the free path (`kaggle-run.ts`); pass `--owner` instead if you'd rather
  not set it. The actual Kaggle credential (`~/.kaggle/kaggle.json`) is read
  by the `kaggle` CLI itself — `kaggle-run.ts` never opens that file.

None of these are ever written into a file in this repo. Put them in
`../yiddish-runner/.env` (already git-ignored) or the shell environment.

## Exact commands, in order

```bash
# 1. See what a dataset would look like — no clips cut, no files written.
npx tsx scripts/yiddish-finetune/build-dataset.ts --dry-run

# 2. Build it for real (defaults: min-confidence 0.55, eval-fraction 5%,
#    gold-weight 3, 16kHz mono WAV clips under dataset/<version>/clips/).
npx tsx scripts/yiddish-finetune/build-dataset.ts --version 2026-09-17-v1
```

Then pick ONE training path — Kaggle first, RunPod as the paid fallback.

### Free path: Kaggle

Kaggle gives every account ~30 GPU-hours/week free (2x T4 or 1x P100, 12h max
per session, internet enabled so pip installs work). `train.py`'s defaults
(batch 4, grad-accum 8, fp16 — T4/P100 have no bf16 — gradient checkpointing,
max-steps 2000, eval every 250 steps) are sized to fit a 16GB card, so this
is the normal path, not a cut-down one.

```bash
# 3. Push the dataset as a PRIVATE Kaggle dataset (train.py/baseline.py/
#    requirements-kaggle.txt are copied in automatically, so the notebook is
#    fully self-contained). --flac halves the upload size (lossless).
#    First time ever for this dataset slug: add --new.
npx tsx scripts/yiddish-finetune/kaggle-run.ts dataset-push \
  --dataset dataset/2026-09-17-v1 --flac --new --confirm \
  --owner <your-kaggle-username> --slug loopcom-yiddish-whisper-dataset

# (see the plan first, with nothing pushed:)
npx tsx scripts/yiddish-finetune/kaggle-run.ts dataset-push \
  --dataset dataset/2026-09-17-v1 --flac --new --dry-run

# 4. Push kaggle_train.ipynb + kernel-metadata.json (enable_gpu: true,
#    is_private: true) and START the run. This is the step that spends
#    Kaggle GPU-hours.
npx tsx scripts/yiddish-finetune/kaggle-run.ts kernel-push --confirm \
  --owner <your-kaggle-username> --dataset-slug loopcom-yiddish-whisper-dataset

# 5. Poll status (each call is a real API request, so it needs --confirm too).
npx tsx scripts/yiddish-finetune/kaggle-run.ts status --confirm --owner <your-kaggle-username>

# 6. Pull /kaggle/working/ (out-ct2/, report.json) back once it says complete.
npx tsx scripts/yiddish-finetune/kaggle-run.ts download --confirm \
  --owner <your-kaggle-username> --out out/2026-09-17-v1-kaggle
```

Baseline WER (the "before" number, run once per dataset — needs
torch+transformers, so run it inside a throwaway Kaggle session or a RunPod
pod, never on Izzy's PC):

```bash
python scripts/yiddish-finetune/baseline.py --dataset dataset/2026-09-17-v1
```

### Paid path (fallback): RunPod, cheap by default

Only reach for this once Kaggle's weekly quota is spent, or a run needs more
than one 12h session. Cheap consumer cards are tried FIRST (RTX 4090 → RTX
3090 → RTX A5000), the 80GB A100s and H100 are the LAST resort, `cloudType`
defaults to COMMUNITY (cheaper than SECURE), and `create`/`run` HARD REFUSE
before spending anything if `price × --max-hours` would exceed
`--max-cost-usd` (default **$10**, `--max-hours` default **2**).

```bash
# See the GPU price, cloud type, and whether it's within the $10 cap —
# NOTHING is created by `plan`.
npx tsx scripts/yiddish-finetune/runpod-pod.ts plan

# Rent the pod, upload the dataset, train, download results, and terminate
# the pod — all in one command, with a watchdog that terminates on
# --max-hours, on error, or on Ctrl-C. REQUIRES --confirm. Refuses outright
# if the chosen GPU's price x --max-hours > --max-cost-usd.
npx tsx scripts/yiddish-finetune/runpod-pod.ts run --confirm \
  --dataset dataset/2026-09-17-v1 --out out/2026-09-17-v1
# (raise the cap explicitly if a bigger/faster GPU is worth it:)
npx tsx scripts/yiddish-finetune/runpod-pod.ts run --confirm \
  --dataset dataset/2026-09-17-v1 --max-hours 4 --max-cost-usd 20

# (equivalent, step by step, if you want to watch each stage:)
npx tsx scripts/yiddish-finetune/runpod-pod.ts create --confirm
npx tsx scripts/yiddish-finetune/runpod-pod.ts wait-ready --pod-id <id>
npx tsx scripts/yiddish-finetune/runpod-pod.ts upload --ip <ip> --port <port> --dataset dataset/2026-09-17-v1
npx tsx scripts/yiddish-finetune/runpod-pod.ts train --ip <ip> --port <port>
npx tsx scripts/yiddish-finetune/runpod-pod.ts train-log --ip <ip> --port <port>   # poll until report.json exists
npx tsx scripts/yiddish-finetune/runpod-pod.ts download --ip <ip> --port <port> --out out/2026-09-17-v1
npx tsx scripts/yiddish-finetune/runpod-pod.ts terminate --pod-id <id>
```

### After either path: serve the fine-tuned model

```bash
# Only after report.json's gold WER beats baseline_report.json's gold WER:
# create (or update) the serverless endpoint that actually SERVES it.
npx tsx scripts/yiddish-finetune/runpod-endpoint.ts create \
  --model loopcom/yi-whisper-finetuned-2026-09-17 --name yc-yiddish-finetuned
# later, to point an EXISTING endpoint at a newer model:
npx tsx scripts/yiddish-finetune/runpod-endpoint.ts set-model --id <endpointId> --model <hf repo>

# Prove the endpoint is actually alive before flipping EVERETT_ENDPOINT_ID
# on the server.
npx tsx scripts/yiddish-finetune/smoke-transcribe.ts path/to/a-20s-clip.wav \
  --endpoint <endpointId> --model loopcom/yi-whisper-finetuned-2026-09-17
```

## What Izzy has to do once, for the free (Kaggle) path

`kaggle-run.ts` never sees or stores a credential — it only shells out to the
`kaggle` CLI, which reads its own config. One-time setup, on the machine that
runs `kaggle-run.ts` (Izzy's PC):

1. **Create a Kaggle account** at kaggle.com if he doesn't have one (a Google
   sign-in works).
2. **Verify by phone number** — Settings → Phone Verification. Kaggle will
   not grant GPU quota to an account that hasn't done this; this is the step
   people most often miss.
3. **Create an API token** — Settings → API → "Create New Token". This
   downloads `kaggle.json` (contains `username` + `key`). Move it to
   `~/.kaggle/kaggle.json` (on Windows: `%USERPROFILE%\.kaggle\kaggle.json`)
   — the `kaggle` CLI reads it from exactly that path by default.
4. `pip install kaggle` on that machine.
5. Set `KAGGLE_USERNAME` (from the same `kaggle.json`, or just pass `--owner`
   each time) — this is his public Kaggle username, not a secret.

Nothing else. `dataset-push`/`kernel-push`/`status`/`download` all just call
the `kaggle` CLI from there.

## Cost formula (paid path)

`runpod-pod.ts plan` prints it, but the arithmetic is: `hourly_price ×
--max-hours` is the HARD CAP shown before anything is created (never the
actual bill — training usually finishes well under the cap and the pod is
terminated the moment `report.json` appears), and `create`/`run` REFUSE
outright once that cap exceeds `--max-cost-usd` (default $10) — including
when the price could not be read at all (unknown price is never treated as
"cheap enough"). Default GPU preference: RTX 4090 → RTX 3090 → RTX A5000 →
A100 80GB PCIe → A100-SXM4-80GB → H100 80GB HBM3 — whichever RunPod actually
has available, at COMMUNITY pricing by default (`--cloud-type SECURE` to pay
more for guaranteed capacity). A serverless endpoint (the "after either path"
step) is pay-per-second and scales to zero workers when idle
(`workersMin: 0`) — it costs nothing while unused, unlike a rented pod.
Kaggle (the free path) costs $0 but is capped at ~30 GPU-hours/week and 12h
per session — `train.py --max-steps`/`--batch-size` can shorten a run to fit.

## Tests

```bash
cd /c/dev/projects/yc-build-wt
node --import tsx --test "scripts/yiddish-finetune/*.test.ts"
python scripts/yiddish-finetune/train.py --self-test
```

The TS tests never touch the network, the DB, or ffmpeg — every dependency
(`fetch`, the DB context lookup, the governance function) is injected. The
governance tests import the REAL `trainingEligibilityOf` from
`apps/api/src/yiddishCorpus/governance.ts`, not a copy, so a change to the
real ladder is what they actually exercise.

`train.py --self-test` runs in tiers and reports exactly which ran — see the
docstring at the top of `train.py`. On Izzy's PC (Python 3.14, no `torch`)
only Tier 0 (pure-Python: jsonl loading, text normalisation, a Levenshtein
WER/CER fallback used ONLY in the self-test) runs; Tiers 1 (`jiwer`) and 2
(`torch`+`transformers`, a tiny randomly-initialised `WhisperConfig` with
stubbed features so nothing downloads from the HF hub) report themselves
SKIPPED there and only run on a pod with the real deps installed.

## What is NOT proven until a real run

- The GraphQL field names in `runpod-pod.ts` / `runpod-endpoint.ts`
  (`podFindAndDeployOnDemand`, `podTerminate`, `gpuTypes`, `saveEndpoint`,
  `myself.endpoints`) are written from public RunPod documentation as of
  2026-09-17, marked `⛔ TODO(integrator, verify against live schema)` at
  each call site. RunPod does not ship a versioned schema file — introspect
  `https://api.runpod.io/graphql` (or just run `plan`/`list`, which are
  read-only) before the first `create --confirm`.
- The `kernel-metadata.json` field list in `kaggle-run.ts`
  (`buildKernelMetadata`) mirrors the documented `kaggle kernels init`
  template as of 2026-09-17, marked `⛔ TODO(integrator, verify against the
  live template)`. Nobody has run `kaggle-run.ts dataset-push` or
  `kernel-push` against a real Kaggle account — that needs Izzy's one-time
  setup above first.
- `train.py`'s heavy path (model loading, LoRA, `Seq2SeqTrainer`,
  `ct2-transformers-converter`) has never executed — there is no GPU on
  Izzy's PC or the Connect server to run it on. Only the self-test's Tier 0
  has actually executed, on this machine, today. The new 16GB-card defaults
  (batch 4, grad-accum 8, bf16-if-supported-else-fp16) and the T4/P100
  no-bf16 codepath are logic-reviewed, not GPU-tested.
- No dataset has been built for real yet (Lane A's `startMs`/`endMs`/etc.
  columns and `transcribe`/`align` handlers are a concurrent, separate
  build) — `build-dataset.ts --dry-run` against a real DB will report 0
  eligible rows until Lane A's handlers have produced `YcTranscript` rows
  with timing.
- No pod has ever been rented, no Kaggle kernel ever pushed, no endpoint
  created, no fine-tune run, no gold WER comparison made. Every number in
  this README's cost formula is arithmetic on RunPod's published prices, not
  a bill anyone has paid.
