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

## ⛔ Honest limitation: the first training round is self-distillation

The first labels this dataset builder can select (`YcTranscript.engine="ivrit"`,
`sttProvider=kaggle:ivrit-ai/yi-whisper-large-v3-turbo`) come from the SAME
model family being fine-tuned. Training on a model's own guesses about itself
is **self-distillation**: it can genuinely help the model adapt to THIS
acoustic domain (telephone/radio-quality Yiddish, these speakers' accents,
Yiddish24's specific recording chain) and to the vocabulary this corpus is
full of — but it **cannot fix an error the model makes consistently**, because
a consistent error IS the label for every clip where it occurs. A model
trained hard enough on its own confident mistakes gets better at being
confidently wrong the same way. This is not a Lane B bug; it is a property of
where the first round's labels come from, and it is the reason WER must be
measured on gold (`engine="human"`) rows separately from the general eval set
— gold is the only number in `report.json` that isn't measuring "did the
model get better at agreeing with itself."

Two real fixes, in order of how much they help:

1. **Human gold rows** (Lane C, `/admin/yiddish-learning/gold`) — a native
   Yiddish speaker corrects the model's actual output. This is real
   supervision, weighted `--gold-weight` times into training and always kept
   in eval. The single highest-value thing to grow.
2. **Labels from the LARGER base model**, `ivrit-ai/yi-whisper-large-v3-ct2`
   (not `-turbo`) — a bigger model's errors are less correlated with the
   turbo model's errors, so training the turbo model on the larger model's
   transcripts is closer to real distillation-from-a-better-teacher than
   self-distillation. This requires a SEPARATE STT pass tagging its
   `sttProvider` distinctly (e.g. `kaggle:ivrit-ai/yi-whisper-large-v3-ct2`) —
   not built by Lane B; Lane A's `transcribe` handler would need to run that
   pass and record the different `sttProvider` string.

`build-dataset.ts` has two knobs to lean toward whichever of these you have:

- **`--min-confidence <n>`** (default 0.55, already existed) — raising it
  drops the machine's LEAST confident guesses, which correlates with (but
  is not the same as) dropping its most wrong ones. Cheap, always available,
  weakest signal.
- **`--prefer-engine <substring>`** (repeatable, or comma-separated in one
  flag; new 2026-09-18) — keeps only `ivrit` rows whose `sttProvider` contains
  one of the given substrings; `engine="human"` (gold) rows are ALWAYS kept
  regardless of this filter. Once a large-v3 pass exists:
  `--prefer-engine large-v3-ct2` builds a dataset from ONLY the bigger model's
  labels (plus all gold). Until it exists, this flag can still narrow a
  mixed corpus down to one specific `ivrit` run by matching a fragment of its
  `sttProvider` tag.

Neither flag changes governance — `trainingEligibilityOf` still runs first
and unconditionally; these are quality/provenance filters layered after it,
exactly like `--min-confidence` always was.

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

# 1b. A bounded SMOKE build against real data — cuts real clips but stops
#     once the ivrit (machine) clips would exceed 2 hours total (gold clips
#     are never capped). Good for a first real run end to end before
#     committing a full corpus to a Kaggle upload.
npx tsx scripts/yiddish-finetune/build-dataset.ts --version smoke-2h --max-hours 2

# 2. Build it for real (defaults: min-confidence 0.55, eval-fraction 5%,
#    gold-weight 3, 16kHz mono WAV clips under dataset/<version>/clips/).
npx tsx scripts/yiddish-finetune/build-dataset.ts --version 2026-09-17-v1

# 2b. Lean toward the least self-distilled labels available (see "Honest
#     limitation" above) instead of the whole ivrit corpus:
npx tsx scripts/yiddish-finetune/build-dataset.ts --version 2026-09-17-v1 \
  --min-confidence 0.7 --prefer-engine large-v3-ct2
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

**Spans more than one 12h session automatically.** `train.py` checkpoints
every `--save-steps` (default 250) under `--output-dir` and, before starting,
looks for the highest `checkpoint-<N>/` already there and resumes from it
(`report.json`'s `resumed_from` records which one, or `null` for a fresh
run). So if a session hits Kaggle's 12h wall mid-training: `kernel-push` the
SAME dataset + `--output-dir` again (Kaggle's own dataset versioning does
not carry `/kaggle/working/` between sessions, so the checkpoint has to
travel WITH the dataset push, or be re-supplied as its own dataset version —
either way, the `output_dir` the next session sees must contain the previous
session's `checkpoint-<N>/`) and it continues from the last saved step
instead of restarting at 0.

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

## What WAS verified against the live DB (2026-09-18)

- `build-dataset.ts --dry-run` ran for real, through the runner's SSH tunnel,
  against the production Connect database. It queries and exits cleanly.
- **Governance was confirmed on real production rows**, not fixtures: Lane
  A's governance update (§3.1.6) HAS landed in `apps/api/src/yiddishCorpus/
  governance.ts` (verified by reading it — the `privateConsented` check is
  in the ladder). Running the REAL `trainingEligibilityOf` against the ACTUAL
  `yiddish24` `YcSource` + `YcRightsRecord` rows in production returns:
  `{"eligibility":"ALLOWED","reasons":[],"primaryReason":null}` — exactly as
  the build spec expected, because a `training_export` right for `yiddish24`
  is GRANTED (`izzy-20260917-y24-training_export`, evidence: Izzy 2026-09-17
  "Yiddish 24 is good."). **Yiddish24 rows are confirmed ALLOWED on real
  data.**
- ⛔⛔ **voicemail and call_recordings are NOT going to flow in even once
  Lane A transcribes them — this is a DB configuration gap, not a Lane B
  code bug.** Both sources DO have a GRANTED `training_export` right (Izzy's
  "I have already cleared it with them… do what I tell you", recorded
  2026-09-17), and `contentAllowed=true`, so rung 1 (`CUSTOMER_PRIVATE`
  unconsented) would now correctly NOT fire for them. But both sources'
  `YcSource.trainingExportEligibility` column is still literally `"EXCLUDED"`
  — a separate, earlier manual flag that fires at rung 3
  (`SOURCE_MARKED_EXCLUDED`) BEFORE the rights grant is ever consulted.
  Verified directly: `trainingEligibilityOf` on the real `voicemail` and
  `call_recordings` rows returns `EXCLUDED` / `SOURCE_MARKED_EXCLUDED` today.
  Someone (the integrator, not Lane B — this is a data change, not a code
  change, and outside `scripts/yiddish-finetune/`) needs to flip
  `trainingExportEligibility` on those two `YcSource` rows away from
  `EXCLUDED` once Izzy's consent is meant to actually take effect.
- **0 `YcTranscript` rows exist in production right now** (`total` = 0, not
  just 0-after-filtering) — confirmed with a direct count, not inferred from
  the dry-run output alone. Lane A's `transcribe`/`align` handlers have not
  produced any output yet, even though the schema migration and the
  audio-ingest pipeline clearly have run (34,289 `YcSourceItem` rows, 1,421
  `YcAudioAsset` rows with `storage="STORED"`, and a spot-checked
  `storageKey` path resolves to a real 31MB mp3 on disk). **This means a real
  "small build with `--max-hours 2`" could not be exercised beyond
  `--dry-run` today — there is nothing yet to build a dataset FROM.** Once
  Lane A produces transcripts, `build-dataset.ts` (including the new
  `--max-hours`/`--prefer-engine` flags) is ready and unit-tested, but has
  only been run against real DATA (as `--dry-run`), never against a real
  non-empty `YcTranscript` set.
- ⛔ **The generated Prisma client in THIS checkout is stale relative to
  `schema.prisma`** — `Prisma.dmmf` for `YcTranscript` lists only the
  pre-migration columns (no `startMs`/`endMs`/`words`/`avgLogprob`/
  `noSpeechProb`/`chunkIndex`). `schema.prisma` has them (the
  `20260917150000_yiddish_transcript_timing` migration's block is right
  there in the file), so this is a codegen staleness issue (`prisma
  generate` needs to run), not a schema/migration gap. Until that client is
  regenerated in whatever checkout actually runs `build-dataset.ts` for
  real, `db.ycTranscript.findMany()` would silently come back without those
  fields and `hasTiming()` would correctly, but uselessly, skip every row —
  this is exactly the kind of silent-drop the code is already defensive
  about, but the defense only helps if someone notices the count is 0 for
  the wrong reason. **Not fixed here** (regenerating a shared Prisma client
  is outside `scripts/yiddish-finetune/`, the scope this build stayed in) —
  flagging it for whoever runs the first real build.

## What is still NOT proven

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
  live template)`. **2026-09-18: the one part of it that WAS wrong — the
  default kernel-slug/title pair disagreeing with each other — is fixed and
  now throws loudly if it ever happens again** (see `titleToKaggleSlug`);
  the rest of the field list is still unverified against a real Kaggle
  account. Nobody has run `kaggle-run.ts dataset-push` or `kernel-push`
  against a real Kaggle account — that needs Izzy's one-time setup above
  first. The dataset's declared licence is fixed to the honest `"other"`
  (2026-09-18 — it used to falsely claim `CC0-1.0`, public domain, on
  copyrighted audio) but this too has only been unit-tested, never pushed.
- `train.py`'s heavy path (model loading, LoRA, `Seq2SeqTrainer`,
  `ct2-transformers-converter`) has never executed — there is no GPU on
  Izzy's PC or the Connect server to run it on. Only the self-test's Tier 0
  has actually executed, on this machine, today (now including
  `find_latest_checkpoint`). The 16GB-card defaults (batch 4, grad-accum 8,
  bf16-if-supported-else-fp16), the T4/P100 no-bf16 codepath, and the new
  periodic-checkpoint + resume-from-checkpoint wiring (`save_strategy=
  "steps"`, `find_latest_checkpoint` feeding `trainer.train
  (resume_from_checkpoint=...)`) are logic-reviewed and self-test-covered
  where they don't need a GPU, but not GPU-tested — nobody has actually
  killed a session mid-training and confirmed the next one resumes.
- The new `--prefer-engine` filter has no real `sttProvider` tag to filter
  BY yet (see "What WAS verified" above — 0 transcripts exist), so it is
  unit-tested against fixtures only, never against a real mixed corpus.
- No pod has ever been rented, no Kaggle kernel ever pushed, no endpoint
  created, no fine-tune run, no gold WER comparison made. Every number in
  this README's cost formula is arithmetic on RunPod's published prices, not
  a bill anyone has paid.
