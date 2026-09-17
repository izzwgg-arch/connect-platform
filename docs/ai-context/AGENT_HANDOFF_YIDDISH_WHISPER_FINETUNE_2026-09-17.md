# Yiddish Whisper fine-tune — the learning loop that actually learns (2026-09-17)

**Owner decisions (Izzy, in chat 2026-09-17):** target = the platform's Yiddish speech-to-text
(ivrit.ai `yi-whisper-large-v3-turbo`); sources = Yiddish24 (site owner said yes), customer
voicemails and call recordings (Izzy as carrier/owner, reaffirmed after the concern was raised);
⛔ Yiddish Labs TEXT is never used as a label or training input (contract). Budget cap: **$5/day total** (Izzy, 2026-09-17: "like $5 a day") = $3/day labelling split per source in
`scripts/yiddish-ingest/integrator-budgets.sql` + ~$2/day averaged GPU (one 2-hour A100 run every 2–3 days,
`--max-hours 2`). ⛔ The stored RunPod key is DEAD (401) and no serverless endpoint exists; a fresh key from Izzy
unblocks the paid part.

This is the design every build lane works from. Parent handoff:
`AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md` (§14 = state before this build).

## 0. Why this exists

The engine downloads audio and extracts acoustic segments, but has **no `transcribe`, `align` or
`cluster` handler** and no STT wired anywhere, so it has produced 0 transcripts, 0 lexemes,
0 rules. It cannot improve a speech model. This build adds the missing stages, a dataset
builder, a fine-tune job on a rented GPU, a human gold set to PROVE improvement, and deployment
of the improved model back to the platform's own STT endpoint.

## 1. Facts the design rests on (verified 2026-09-17)

- Base model: HF `ivrit-ai/yi-whisper-large-v3-turbo` (Transformers) exists; production serves
  the CT2 conversion `ivrit-ai/yi-whisper-large-v3-turbo-ct2` through the ivrit.ai
  `runpod-serverless` worker (`engine: "faster-whisper"`, payload documented in
  `apps/agent/src/transcription/everett.ts`). Cost ≈ 3–4¢ per audio hour.
- The RunPod API key is the agent secret `ivrit_api_key` (encrypted in `AgentSecret`, master key
  in the agent container env). ⛔ `EVERETT_ENDPOINT_ID` is NOT set anywhere on the server — the
  serverless endpoint may not exist yet; lane B must be able to create it.
- Audio lives on Izzy's PC (runner `C:\Users\izzyw\LoopcomYiddishRunner`, repo copy
  `scripts/yiddish-runner/`): Yiddish24 MP3 ~92 kbps; voicemails 8 kHz mono PCM WAV (1,888
  files, 1.3 GB, all copied); call recordings are 8 kHz mono PCM WAV on the PBX spool
  (`/var/spool/asterisk/monitor/<tenanthash>/YYYY/MM/DD/*.wav`, 187 GB total; Yiddish-speaking
  tenants ≈ 810 h, Gesheft alone 355 h). ⛔ PBX is READ-ONLY: copy off with scp, never write.
- Neither the PC (Intel HD 4000, 16 GB) nor the server has a GPU. Training = rented RunPod pod.
- Governance ladder (`governance.ts` `trainingEligibilityOf`): CUSTOMER_PRIVATE is rung 1 →
  EXCLUDED unconditionally today. Izzy's consent as owner must become a recorded, checkable
  basis (see §3.4), never a code default.
- Budget resolution (`jobs.ts` `loadBudget`): a source's own budget wins; otherwise `global`.
  `transcribe` DEFERs while `transcriptionMinutesPerDay <= 0`. `chargeBudget` records cents +
  minutes. `voicemail` / `call_recordings` have NO source budget today → they fall to the paused
  global row.
- `claimJobs` filters by stage only (no per-source filter). The runner analyses on-disk first
  (`segment`,`features`), then fetches.

## 2. Architecture

```
PC runner (izzy-pc)                     RunPod                          Connect server
 fetch_audio ─┐                                                           api: budgets, rights,
 segment      ├─ local ffmpeg                                             gold routes, review UI
 features    ─┘                                                           worker: novelty, observe,
 transcribe ──── chunks ≤10 min ──► serverless faster-whisper (yi) ──► aggregate (server lane)
 align (local: whisper segments → YcSegment)
 build_dataset ── clips ≤30 s + text + confidence ──► dataset/ (PC)
 train ─────────── scp dataset ──► on-demand A100 pod: LoRA/FT ──► CT2 ──► HF repo
                                                                     └► new serverless endpoint
                                                                        (EVERETT_MODEL flips)
```

## 3. Lane specs

### 3.1 Lane A — engine: `transcribe` + `align` + governance consent (apps/api/src/yiddishCorpus)

1. **Migration** `packages/db/prisma/migrations/20260917150000_yiddish_transcript_timing/`
   (additive only): on `YcTranscript` add `startMs Int?`, `endMs Int?`, `words Json?`,
   `avgLogprob Float?`, `noSpeechProb Float?`, `chunkIndex Int?`. Update `schema.prisma` as
   "origin + our block" (⛔ never `prisma format` the whole file — see parent handoff traps).
2. **`everettClient.ts`** in `yiddishCorpus/`: a copy of the agent's client (same payload,
   `language: "yi"` forced, never `he`), reading `EVERETT_API_KEY` + `EVERETT_ENDPOINT_ID` +
   `EVERETT_MODEL` from env, with `word_timestamps: true` in `transcribe_args`. Unit-testable via
   an injectable `fetch`. Never logs the key.
3. **`transcribe` handler** (`defaultStageHandlers.transcribe`):
   - needs a STORED asset with `storageKey`; else SKIP "no stored audio".
   - re-reads the customer wall (`contentAllowed`) like `observe` does; if walled → SKIP with
     `YC_CUSTOMER_WALL_MESSAGE`.
   - splits audio with ffmpeg (`audioPipeline.ts` helpers; add `cutChunk(path, startMs, endMs)`
     → 16 kHz mono MP3 ≤ 7 MB) into chunks of ≤ `YC_TRANSCRIBE_CHUNK_SEC` (default 600),
     aligned to SPEECH segment boundaries where possible; skips chunks whose SPEECH ratio is 0.
   - calls Everett per chunk; writes one `YcTranscript` row per whisper segment:
     `engine="ivrit"`, `sttProvider=<EVERETT_MODEL>`, `language`, `text`, `startMs/endMs`
     (offset by chunk start), `words`, `avgLogprob`, `noSpeechProb`, `confidence` (derived:
     `exp(avgLogprob)` clamped, minus a penalty for `noSpeechProb`), `chunkIndex`,
     `originRef = "<assetId>#<chunk>"`.
   - idempotent: existing rows for the same `(itemId, engine="ivrit", originRef)` are not
     duplicated (delete-and-rewrite per chunk is acceptable).
   - returns `{ ok, advance, transcribedMinutes, costCents }` with
     `costCents = ceil(minutes * YC_EVERETT_CENTS_PER_AUDIO_MINUTE)` (env, default 0.07).
   - sets item `state = "TRANSCRIBED"`.
   - ⛔ never calls Yiddish Labs. A guard test asserts the file has no YL marker string and no
     `yiddishLabs` import.
4. **`align` handler**: for each `ivrit` transcript row with timing, find the SPEECH `YcSegment`
   of the item's asset with the largest overlap; set `segmentId`. Rows with no overlapping SPEECH
   segment stay `segmentId = null` (they are still usable text). Set item `state = "ALIGNED"`.
   `observe` then produces `ACOUSTIC_ALIGNED` observations for free.
5. **`cluster`**: leave unimplemented (audio-gated; documented as "not needed for the STT
   fine-tune; planned"). Do NOT remove it from the stage list.
6. **Governance consent rung** (`governance.ts`): CUSTOMER_PRIVATE stops being an unconditional
   EXCLUDED. New rule: a CUSTOMER_PRIVATE source is treated as consented ONLY when
   `contentAllowed === true` AND a `YcRightsRecord` with `allowedUse="training_export"` and
   `state="GRANTED"` exists for it (`opts.rights`). Without both → EXCLUDED as before. The YL rung
   is untouched and still fires first for YL rows. Add tests: (a) private + grant + consent →
   not excluded by rung 1; (b) private without grant → EXCLUDED CUSTOMER_PRIVATE; (c) private +
   grant but row YL → EXCLUDED YL_DERIVED. `exclusionBreakdown`/export preview must reflect it.
7. **Budget**: `budgetVerdict` unchanged. Add a route body field or SQL recipe (documented) to
   create `source:voicemail` / `source:call_recordings` budgets (the existing
   `POST /sources/:key/budget` already upserts per-source — verify it works for INTERNAL_TABLE
   sources and fix if it refuses).
8. **Cost ledger**: expose per-source `spentCentsToday`, `transcribedMinutesToday`, and
   all-time sums (new `YcMetricSnapshot` metrics `transcribe.minutes`, `transcribe.cents` per
   day per source) in `GET /admin/yiddish/now` and the dashboard payload.
9. Tests: fake db + fake Everett fetch; chunking math; budget charge; wall; idempotency; align
   overlap; guard tests. `learningStages.test.ts` must still pass (transcribe/align now have
   handlers — that is allowed).

### 3.2 Lane B — dataset + training + deployment (`scripts/yiddish-finetune/`)

All scripts run on the PC (Node 24 for TS via `tsx`; Python 3.14 present, no torch — Python
training code runs ON THE POD, not the PC). DB access through the runner's tunnel
(`DATABASE_URL` from `../yiddish-runner/.env`).

1. **`build-dataset.ts`**: select `YcTranscript` rows `engine="ivrit"` joined to item, source,
   rights; apply `trainingEligibilityOf` (import from the api module via relative path to the
   runner's code snapshot) → keep ALLOWED only (this is what makes YL exclusion and consent real);
   `confidence >= --min-confidence` (default 0.55), `noSpeechProb <= 0.5`, text length 3–400 chars,
   duration 1–30 s (merge adjacent rows up to 30 s); cut clips with ffmpeg to 16 kHz mono 16-bit
   WAV under `dataset/<version>/clips/`; write `train.jsonl` / `eval.jsonl` (HF audiofolder
   shape: `{"audio": "clips/x.wav", "text": "...", "source": "...", "item": "...", "confidence":
   0.8, "gold": false}`), 5% eval by item (never split an item across train/eval), gold rows
   (engine `human`) ALWAYS in eval and duplicated into train with `--gold-weight` repeats.
   Prints a stats report (hours per source, clips, mean confidence, gold count) and writes
   `manifest.json` with sha256 of every jsonl. `--dry-run` computes stats without cutting.
2. **`train.py`** (runs on the pod): HF `transformers` Seq2SeqTrainer on
   `ivrit-ai/yi-whisper-large-v3-turbo`, language `yi`, task `transcribe`; default LoRA via
   `peft` (`--full` for full FT), fp16/bf16, gradient checkpointing, `--max-steps`, eval WER + CER
   with `jiwer` on eval.jsonl AND a separate gold-only WER; saves merged weights; then
   `ct2-transformers-converter ... --quantization float16` → `out-ct2/`; optional
   `--push-to-hub <repo>` (needs `HF_TOKEN`). Writes `report.json` (before/after WER on gold,
   train hours, steps, wall time, $ estimate).
3. **`baseline.py`**: WER of the UNTUNED model on the same eval/gold sets (the "before" number).
4. **`runpod-pod.ts`**: RunPod GraphQL (`Bearer $RUNPOD_API_KEY`): create an on-demand pod
   (default GPU `NVIDIA A100 80GB PCIe`, fall back to `A100-SXM4-80GB` / `H100 80GB HBM3`;
   image `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`; 200 GB volume; SSH
   exposed), print the hourly price and a hard `--max-hours` BEFORE creating, refuse without
   `--confirm`; `wait-ready`, `scp` dataset + scripts up, run `train.py` under `nohup`, poll
   logs, `scp` `out-ct2/` + `report.json` back, then **terminate the pod** (also on any error /
   SIGINT / `--max-hours` reached). `--dry-run` prints the plan and price only.
5. **`runpod-endpoint.ts`**: create/update the serverless STT endpoint from the ivrit.ai
   `runpod-serverless` template (Docker image `ivritai/runpod-serverless:latest` or the image the
   template uses — read it from RunPod's template list via GraphQL; if unreachable, document the
   exact manual steps), env `MODEL_NAME=<hf repo>`; `--model` flips between the stock
   `ivrit-ai/yi-whisper-large-v3-turbo-ct2` and our fine-tuned repo. Prints the new
   `EVERETT_ENDPOINT_ID`. Never deletes an endpoint.
6. **`smoke-transcribe.ts`**: send one 20-second clip to an endpoint and print text + timing
   (the thing that proves an endpoint is alive).
7. Tests (node:test): dataset filters (YL row excluded, private-without-grant excluded, low
   confidence excluded, item never split across train/eval, gold always in eval), manifest
   hashing, pod plan math (`--dry-run` never calls the network — injectable fetch), endpoint
   payload shape. Python: `pytest`-free minimal `--self-test` in `train.py` that builds a 3-row
   fake dataset and runs the collator + metric code on CPU without downloading a model.

### 3.3 Lane C — gold set + review UI (api routes + portal)

Purpose: a native ear corrects a few hundred clips → the eval set that proves improvement
and the highest-weight training rows.

1. **api routes** (`routes.ts`, owner-only, tenant-free like the rest):
   - `POST /admin/yiddish/gold/sample { count, sourceKeys?, minSec?, maxSec? }` → picks
     transcript rows (engine `ivrit`, has timing, 3–20 s, spread across sources/items/confidence
     buckets, prefers LOW confidence = where the model struggles) and creates `YcReviewItem`
     rows `subjectType="TRANSCRIPT"`, `subjectId=<transcriptId>`, `reason="gold_candidate"`,
     `detail={ itemId, assetId, startMs, endMs, text, confidence, sourceKey }`. Idempotent per
     transcript.
   - `GET /admin/yiddish/gold` → open TRANSCRIPT review items with the machine text; hides
     customer-private content unless `contentAllowed` (same wall as everything else).
   - `POST /admin/yiddish/gold/:reviewId/decide { decision: "correct"|"accept"|"reject"|"skip",
     text? }` → `correct`/`accept` write a `YcTranscript` row `engine="human"`,
     `sttProvider="izzy"` (actor), same `itemId/segmentId/startMs/endMs`, `confidence=1`,
     `originRef="gold:<reviewId>"`; `reject` marks the machine row unusable (`confidence=0`,
     detail reason); review item state APPROVED/EDITED/REJECTED/DEFERRED.
   - `PUT /admin/yiddish/gold/clips/:reviewId` (raw `audio/wav`, ≤ 3 MB) stores under
     `$YIDDISH_CORPUS_STORAGE_DIR/gold/<reviewId>.wav`; `GET` streams it (`Range` ok). The PC
     runner uploads the clip for each open gold item (`scripts/yiddish-runner/push-gold-clips.ts`,
     lane B/C shared: cut with ffmpeg 16 kHz mono, then `PUT` with an owner token from
     `.env` `YC_API_TOKEN` — OR scp into the volume host path if the token route is not ready;
     document whichever ships).
   - `GET /admin/yiddish/gold/stats` → counts open/decided, gold hours, per-source, and the
     latest `report.json` numbers if lane B has uploaded one (`POST /admin/yiddish/finetune/report`).
2. **Portal** `apps/portal/app/(platform)/admin/yiddish-learning/gold/page.tsx` (+ nav entry
   under the existing Yiddish section, + permission key `can_view_yiddish_gold` following the
   pattern of the other 10 keys — ⛔ the fourth rule: toggles on `/admin/permissions` and
   `/admin/roles/[id]` come from `navConfig`, so add the nav item and the key in the same
   commit): one clip at a time: audio player (the `GET clips` URL), the machine text in a big
   RTL textarea, buttons **Correct (save my text)**, **It's right**, **Unusable**, **Skip**;
   keyboard: Enter = save, Space = play/pause; a progress bar "N of M reviewed, X minutes of
   gold". Source + confidence chips. Uses `YiddishUi` primitives; ConnectSelect for any dropdown.
3. Tests: route sampling spreads across sources and prefers low confidence; decide writes a
   `human` row and never touches the machine row's text; clip route refuses >3 MB and non-wav;
   portal guard test that the nav item + key exist (mirror `permissionToggleCoverage.test.ts`
   expectations).

### 3.4 Lane D — ingest: call recordings + consent records (`scripts/yiddish-ingest/`)

1. **`register-call-recordings.ts`** (runs INSIDE `app-api-1` like `yc-backfill-categories.ts`):
   for tenants that have any `Voicemail.transcriptLanguage in (yi, yi-en)`, take `ConnectCdr`
   rows with `recordingPath` set, `recordingMissingAt` null, `talkSec >= 20`; create `YcSource`
   `call_recordings` items (`externalId = linkedId`, `durationSec = talkSec`, `metadata =
   { tenantId, pbxPath, direction, startedAt, localAudioPath: "<linkedId>.wav" }`), state
   `QUEUED`, and enqueue via `enqueueNext`. Idempotent (unique `sourceId+externalId`).
   `--tenant <name>` and `--limit` for a pilot; `--dry-run` counts only. ⛔ Never reads the
   audio, never touches YL text.
2. **`copy-call-recordings.ts`** (runs on the PC): for registered items whose local file is
   missing, `scp` from the PBX (READ-ONLY box; key `connect2_server2_ed25519`) into
   `LoopcomYiddishRunner/audio/call_recordings/<linkedId>.wav`, batching with `tar | ssh` per
   day-folder, `--max-gb`, `--tenant`, resumable, throttled (`--bwlimit`), verifies size; writes
   a progress file. ⛔ Only `scp`/`tar -c` on the PBX side — no writes, no deletes.
3. **Language probe** (in lane A's transcribe or here as a runner pre-stage): for
   `call_recordings` items, transcribe only the first 30 s with `language: auto` first; if the
   detected language is not Hebrew-script Yiddish (`normalizeLanguage` → `yi`/`yi-en`), mark the
   item SKIPPED "not Yiddish" and stop. Saves ~½ the spend on English calls.
4. **Consent + rights SQL** (`consent-records.sql`, applied by the integrator, not the lane):
   `YcRightsRecord` `training_export` GRANTED for `yiddish24` (evidence: Izzy 2026-09-17
   "Yiddish 24 is good"), `voicemail` and `call_recordings` (evidence: Izzy 2026-09-17 "I have
   already cleared it with them… do what I tell you"), `decidedBy = "izzy (Loopcom owner, via
   Claude chat)"`; `call_recordings` source `audioFetchMode=OWNER_AUTHORIZED`,
   `contentAllowed=true`; `trainingExportEligibility` left for the ladder to decide (do not set
   ALLOWED by hand).
5. Runner generalisation (`scripts/yiddish-runner/runner.ts`): the voicemail fetch handler becomes
   `internalAudioFetchHandler` for any source whose items carry `metadata.localAudioPath`, reading
   `audio/<sourceKey>/<file>`.

## 4. Integration order (the integrator = the main session)

1. Land lane A (migration + handlers) → api tests → deploy api (migration runs in the deploy) →
   regenerate the runner's Prisma client (`npm run generate` in the runner, after refreshing
   `code/`) → add `transcribe`,`align` to the runner's stage list and to
   `YIDDISH_WORKER_EXCLUDE_STAGES` on the server (compose default) → restart runner.
2. Rights + consent SQL (§3.4.4) → per-source budgets with Izzy's cap
   (`transcriptionMinutesPerDay`, `apiCentsPerDay`) → un-park voicemail jobs
   (`nextRunAt = now()` where parked to 2027) → watch transcripts appear.
3. Lane C live → sample 300 gold candidates → runner pushes clips → Izzy reviews.
4. Lane B: dry-run, baseline WER, first LoRA run on a rented A100 with `--max-hours 4`, report,
   endpoint with the new model, smoke transcribe, flip `EVERETT_MODEL` only after the gold WER
   is better than baseline.
5. Docs: parent handoff §15, summary file, CLAUDE.md index line, TESTS_RUN, memory.

## 5. Standing rules for every lane

- Commit only your own paths; the integrator commits. Never `git add -A`, never `prisma format`.
- No secrets in the repo: RunPod / Everett / HF tokens come from env or the runner `.env`.
- ⛔ Yiddish Labs text is never a label, never an input, never a fallback.
- ⛔ The PBX is read-only. ⛔ Never forge the Yiddish24 Referer outside the existing gate.
- Every paid call is metered through `chargeBudget`; a stage that cannot meter must not run.
- Tests: `cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/yiddishCorpus/*.test.ts"`.
