# Yiddish learning engine — ingest & consent SQL (integrator-applied)

This folder holds the **SQL recipes** the integrator runs by hand against the
production database to move the Yiddish Whisper fine-tune loop forward. None
of these are applied automatically by any script, migration or engine code —
each is a recorded, human decision, applied once, and safe to re-run
(idempotent) if it ever needs to be.

None of these files touch audio or transcript text. They only touch
`YcSource`, `YcRightsRecord`, `YcBudget` and `YcProcessingJob` rows — the
governance and scheduling metadata around the corpus, never its content.

## Files, in the order they are meant to be applied

1. **`consent-records.sql`** (§3.4.4, `AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md`)
   — records Izzy's owner-authority consent as `YcRightsRecord` rows
   (`training_export` GRANTED for `yiddish24`, `voicemail`, `call_recordings`;
   `analysis` + `store_audio` GRANTED for `call_recordings`, mirroring
   voicemail's existing grant) and flips `call_recordings` to
   `audioFetchMode = 'OWNER_AUTHORIZED'`, `contentAllowed = true`. This is the
   file that makes the new governance rule in `governance.ts`
   (`trainingEligibilityOf`) actually excuse `voicemail`/`call_recordings`
   from the unconditional `EXCLUDED` rung a `CUSTOMER_PRIVATE` source starts
   at — apply it only after Lane A's migration and governance change are live.
   ⛔ Yiddish Labs (`yiddishlabs_cache`) gets no row here, ever.

2. **`integrator-budgets.sql`** — per-source `YcBudget` rows (daily minute and
   cent caps) for `voicemail` and `call_recordings`, and raises Yiddish24's
   caps to match. A source's own budget wins over the paused/METADATA_ONLY
   global row, so this is what actually lets audio stages run for these
   sources once the rights records above allow it. Replace the numbers with
   whatever daily cap Izzy has actually given before applying.

3. **`unpark-voicemail-jobs.sql`** — revives the voicemail `fetch_audio` jobs
   that were parked (`nextRunAt` pushed to 2027) after they were found
   starving the Yiddish24 download (see
   `scripts/yiddish-runner/README.md` "Known limits"). Apply only after
   voicemail has its own running budget, so its jobs advance instead of
   deferring every tick and starving the queue again.

## Where the actual ingest code lives (not SQL, not in this folder)

- **`apps/api/scripts/yc-register-call-recordings.ts`** — runs INSIDE the api
  container (`docker exec ... npx tsx scripts/yc-register-call-recordings.ts`,
  same pattern as `yc-backfill-categories.ts`). Turns a Yiddish-speaking
  tenant's long-enough, recorded `ConnectCdr` rows into `call_recordings`
  `YcSourceItem` rows the audio pipeline can claim. Metadata only — it never
  opens a recording.
- **`scripts/yiddish-runner/copy-call-recordings.ts`** — runs on Izzy's PC,
  next to `runner.ts`. Copies the audio those items point at off the
  READ-ONLY PBX, in day-folder batches, verified and resumable. See that
  folder's README for the full read-only-PBX guarantee.

The order that actually gets audio flowing is: register (api container) →
consent + budget SQL (this folder, integrator) → copy (PC) → the runner's
`fetch_audio`/`segment`/`features` stages pick the copied files up.
