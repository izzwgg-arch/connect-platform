# Loopcom Yiddish audio runner (off-box, runs on Izzy's PC)

This is a **committed copy** of the runner that lives and runs at
`C:\Users\izzyw\LoopcomYiddishRunner` on Izzy's PC. It exists so the audio
stages of the Yiddish Learning Engine (`apps/api/src/yiddishCorpus`) run on a
machine with spare storage instead of the production call server. The server
worker is told to skip these stages by
`YIDDISH_WORKER_EXCLUDE_STAGES=fetch_audio,segment,features` (see
`docker-compose.app.yml`, shipped in commit `51072578`).

## What it does

- Claims the audio stages `fetch_audio`, `segment`, `features` — and, once the
  integrator has landed Lane A and updated the claim lists below and the
  server's `YIDDISH_WORKER_EXCLUDE_STAGES`, `transcribe` and `align` too —
  from the shared engine queue, using lease owner `izzy-pc`. (2026-09-17:
  `transcribe`/`align` now have handlers in the shared engine — see
  `docs/ai-context/AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md` §4.1 —
  but this runner's `stages:` claim lists are not switched over yet; `STAGES`
  in `runner.ts` is the up-to-date list of what this runner is MEANT to carry.)
- Keeps the downloaded MP3/WAV files on the PC (`audio/`), and writes results
  (segments, features, `YcAudioAsset` rows) back to the Connect database over an
  SSH tunnel (`tunnel.cmd` → `127.0.0.1:15432`).
- Analyzes what is already on disk (`segment`, `features`) before downloading
  more (`fetch_audio`), so a big download queue never starves the local work.
- Carries `internalAudioFetchHandler`, a single fetch handler for ANY
  INTERNAL_TABLE source whose items carry `metadata.localAudioPath` — it reads
  `audio/<sourceKey>/<file>` instead of downloading anything. Today that is:
  - `voicemail` — customer voicemail audio, bulk-copied ahead of time
    (audio only; the Yiddish Labs transcript is never read).
  - `call_recordings` — customer call recordings, copied ahead of time by
    `copy-call-recordings.ts` (below) from the read-only PBX (audio only; no
    transcript text is ever read here either).

  Any future internal audio source needs no change to this handler — only a
  registration script like `apps/api/scripts/yc-register-call-recordings.ts`
  that stamps `metadata.localAudioPath` on its items.
- `languageProbe.ts` is a pure helper (`probeDecision`) for a cheap check on
  `call_recordings` items — "is the first ~30s of this call actually Yiddish,
  or plain English?" — meant to be called from the shared engine's
  `transcribe` handler (see the `TODO` comment above
  `internalAudioFetchHandler` in `runner.ts`), not from this runner. This
  runner downloads audio; it does not transcribe.

The audio rights gate in the shared engine still applies: a source only
downloads while it is `OWNER_AUTHORIZED` with a GRANTED `YcRightsRecord`
(see `scripts/yiddish-ingest/consent-records.sql`).

## Other scripts in this folder

- **`copy-call-recordings.ts`** — pulls `call_recordings` audio off the
  READ-ONLY PBX (`209.145.60.79`) in day-folder batches (one `tar -c` over one
  `ssh` per PBX day-folder, never per file), verifies each file's size against
  a preceding `ls -l` before counting it as copied, and resumes from
  `logs/copy-call-recordings.json`. Flags: `--tenant <substr>`, `--max-gb <n>`,
  `--bwlimit <kbit/s>`, `--dry-run`. ⛔⛔ It emits exactly three kinds of
  remote command — `ls`, `stat`, `tar -c` (create, never extract) — through
  ONE function (`buildRemoteCommand`); nothing else in the file talks to the
  PBX. Run it after `apps/api/scripts/yc-register-call-recordings.ts` has
  registered items in the api container.

## Run / stop

- `start.cmd` launches the tunnel and the runner in a loop; a "Loopcom Yiddish
  Runner" scheduled task also starts it at sign-in.
- Create a file named `STOP` in the folder (or close the window) to stop it.
- `copy-call-recordings.ts` is run by hand (`npx tsx copy-call-recordings.ts
  [flags]`) — it is a batch job, not a long-running loop.

## Setup

1. `npm install`
2. `npm run generate` (generates the Prisma client from `code/packages/db`)
3. Copy `.env.example` to `.env` and fill in the real `DATABASE_URL` — both
   `runner.ts` and `copy-call-recordings.ts` read this same file.
4. `code/` is a snapshot of `apps/api/src/yiddishCorpus` + `packages/db` from the
   repo, so the runner runs the exact same stage code as production.
5. For `copy-call-recordings.ts`: the PBX SSH key (`connect2_server2_ed25519`)
   is expected at `<repo root>/.connect-ssh/connect2_server2_ed25519` by
   default, or set `PBX_SSH_KEY` to point at a copy on this PC.

## Known limits (read before reviving the voicemail leg, or scaling up call recordings)

- `runDueJobs`/`claimJobs` filter by **stage only**, not by source. When the
  `fetch_audio` lane runs, it claims that stage across **every** source. On
  2026-09-17 the customer-voicemail source's 1,888 fetch jobs (deferred because
  their budget was paused) kept getting claimed and re-deferred, which **starved
  the Yiddish24 download for ~2 hours**. The fix was to park the voicemail fetch
  jobs (`nextRunAt` far in the future). If the voicemail leg is revived, or
  `call_recordings` volume grows the same way, either give the source a
  running budget so its jobs actually advance, or add a per-source filter to
  `claimJobs` first — otherwise it will starve Yiddish24 again.
- `copy-call-recordings.ts` has never been run against the real PBX by this
  build — the pure parts (day-folder grouping, the PBX-filename→linkedId
  mapping, size verification, the resume file, and the remote-command guard)
  are tested in `copyCallRecordings.test.ts`; the live ssh/tar leg is
  unproven. Run it once with `--dry-run --tenant <one small tenant>` first.
- The language probe (`languageProbe.ts`) is not wired into the shared
  engine's `transcribe` handler yet — see the `TODO` in `runner.ts` above
  `internalAudioFetchHandler`. Until it is, every `call_recordings` item pays
  for a full transcription, English calls included.
