# FREE Kaggle labelling pipeline (Yiddish learning engine)

Audio already sits on this PC (`YcAudioAsset.storageKey`, `storage="STORED"`)
with no `YcTranscript` row (`engine="ivrit"`) — 661 Yiddish24 episodes,
~150 hours. This pipeline gets it labelled on Kaggle's **free** 2x T4 GPUs
(~30 GPU-hours/week per account) instead of spending the paid RunPod budget
(`../yiddish-finetune/runpod-pod.ts`, kept as the fallback once Kaggle's free
quota is spent, or for the actual fine-tune run).

Sibling of `../yiddish-finetune/kaggle-run.ts` — same shape (pack/push/run →
status → pull → import), same `--confirm`/`--dry-run` gates, same rule that
the `kaggle` CLI is the only thing that ever touches Kaggle credentials
(`~/.kaggle/access_token`, read by the CLI itself — never by this repo).

## Command order

```bash
cd scripts/yiddish-labelling

# 1. Pack a batch: read-only DB select + local ffmpeg transcode. Repeatable —
#    a --dry-run first shows the count/hours/size without touching disk.
npx tsx kaggle-label.ts pack --source yiddish24 --batch 2026-09-17-a --dry-run
npx tsx kaggle-label.ts pack --source yiddish24 --batch 2026-09-17-a --max-gb 15

# 2. Push the batch as a PRIVATE Kaggle dataset (first time: --new).
npx tsx kaggle-label.ts push --batch 2026-09-17-a --new --confirm

# 3. Start the GPU kernel (kaggle_label.ipynb) attached to that dataset.
npx tsx kaggle-label.ts run --batch 2026-09-17-a --confirm

# 4. Poll until it finishes (Kaggle sessions cap at 12h; a batch built to
#    --max-hours below that should finish well inside one session).
npx tsx kaggle-label.ts status --batch 2026-09-17-a --confirm

# 5. Pull transcripts.json back.
npx tsx kaggle-label.ts pull --batch 2026-09-17-a --confirm

# 6. Import into YcTranscript + advance the pipeline (DB write, no network).
npx tsx kaggle-label.ts import --batch 2026-09-17-a
```

`--owner <kaggle-username>` overrides `KAGGLE_USERNAME` on any subcommand
that talks to Kaggle (push/run/status/pull) — the username is public, never
a secret, and is the only Kaggle identity this script ever needs to know.

## Two-T4 throughput math (why batches are sized the way they are)

`faster-whisper` on a T4 at `compute_type="float16"` with `beam_size=1` on
`large-v3-turbo`-class models runs comfortably faster than real-time —
roughly 8-12x on clean speech, call it **~10x** as a planning number. Two T4s
running one worker process each in parallel (`kaggle_label.ipynb`'s
`ProcessPoolExecutor(max_workers=2)`, manifest split in half) means:

- ~150h of audio ÷ 2 GPUs = ~75h of audio per GPU
- at ~10x real-time: ~75h ÷ 10 ≈ **~7.5 wall-clock hours** to label the
  entire 661-episode backlog in one Kaggle session (well under the 12h cap,
  with headroom for slower stretches, VAD overhead, and per-file retries).
- at ~24kbps mono Opus, the whole 150h backlog is ~150 × 3600 × 24000/8 bytes
  ≈ **~16GB** — split across 2 batches of `--max-gb 15` (or a couple more,
  smaller ones) rather than one dataset, since Kaggle datasets and uploads
  are friendlier well under any single hard cap.
- ~30 free GPU-hours/week per account means the whole backlog (≈15 GPU-hours
  used, 2 GPUs × ~7.5h) fits inside ONE week's free quota with room to spare
  for a second pass or new episodes as Yiddish24 publishes them.

These are planning numbers, not a promise — `kaggle_label.ipynb` measures and
prints its own real elapsed time and per-GPU progress every 10 files, and
`status`/`pull` are how you find out what actually happened.

## Customer-audio guardrail

`pack` refuses any `--source` other than `yiddish24` unless
`--allow-customer-sources` is also passed. Yiddish24 is the site the owner
already said yes to (`AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md`
§0). Voicemail and call-recording audio are CUSTOMER_PRIVATE sources — even
though the owner has separately authorized their use for the platform's own
training pipeline, that consent is scoped to Loopcom's own infrastructure,
not to uploading raw customer audio bytes to a third-party GPU host's
private dataset. `--allow-customer-sources` exists so that decision is made
explicitly, in the command line, by whoever runs it — never silently.

## Rules (same ones `../yiddish-finetune/kaggle-run.ts` carries)

- No secrets in any file this repo owns. The `kaggle` CLI reads
  `~/.kaggle/access_token` itself; this code never opens that file and never
  reads `KAGGLE_KEY`/`KAGGLE_API_KEY`.
- Yiddish Labs text is never a label, never an input, never referenced.
- Every subcommand that reaches the Kaggle API (`push`, `run`, `status`,
  `pull`) refuses without `--confirm`. `pack` and `import` are local/DB work
  and are not network-gated.
- `import` never reimplements the platform's `transcriptConfidence` /
  `enqueueNext` / `recordTranscribeSpend` — it imports them from
  `YC_ENGINE_ROOT/jobs.ts` (default `apps/api/src/yiddishCorpus`, overridable
  with `--engine-root` or the `YC_ENGINE_ROOT` env var), so labelled rows can
  never drift from how the real `transcribe` stage computes confidence or
  advances the pipeline.
- `import` is idempotent: re-running it for the same batch deletes and
  rewrites that batch's own rows (keyed by `originRef = "<assetId>#kaggle:<batch>"`)
  rather than duplicating them, and `enqueueNext` on an item that has already
  advanced past `transcribe` is a no-op (it only queues a stage that isn't
  already PENDING/RUNNING/DONE).

## Tests

```bash
cd /c/dev/projects/yc-build-wt
node --import tsx --test "scripts/yiddish-labelling/*.test.ts"
```
