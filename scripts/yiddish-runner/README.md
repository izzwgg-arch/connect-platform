# Loopcom Yiddish audio runner (off-box, runs on Izzy's PC)

This is a **committed copy** of the runner that lives and runs at
`C:\Users\izzyw\LoopcomYiddishRunner` on Izzy's PC. It exists so the audio
stages of the Yiddish Learning Engine (`apps/api/src/yiddishCorpus`) run on a
machine with spare storage instead of the production call server. The server
worker is told to skip these stages by
`YIDDISH_WORKER_EXCLUDE_STAGES=fetch_audio,segment,features` (see
`docker-compose.app.yml`, shipped in commit `51072578`).

## What it does

- Claims only the audio stages `fetch_audio`, `segment`, `features` from the
  shared engine queue, using lease owner `izzy-pc`.
- Keeps the downloaded MP3/WAV files on the PC (`audio/`), and writes results
  (segments, features, `YcAudioAsset` rows) back to the Connect database over an
  SSH tunnel (`tunnel.cmd` → `127.0.0.1:15432`).
- Analyzes what is already on disk (`segment`, `features`) before downloading
  more (`fetch_audio`), so a big download queue never starves the local work.
- Also carries a voicemail fetch handler that reads customer voicemail audio
  from `audio/voicemail/` (audio only — the Yiddish Labs transcript is never
  read). See "Known limits" below.

The audio rights gate in the shared engine still applies: a source only
downloads while it is `OWNER_AUTHORIZED` with a GRANTED `YcRightsRecord`.

## Run / stop

- `start.cmd` launches the tunnel and the runner in a loop; a "Loopcom Yiddish
  Runner" scheduled task also starts it at sign-in.
- Create a file named `STOP` in the folder (or close the window) to stop it.

## Setup

1. `npm install`
2. `npm run generate` (generates the Prisma client from `code/packages/db`)
3. Copy `.env.example` to `.env` and fill in the real `DATABASE_URL`.
4. `code/` is a snapshot of `apps/api/src/yiddishCorpus` + `packages/db` from the
   repo, so the runner runs the exact same stage code as production.

## Known limits (read before reviving the voicemail leg)

- `runDueJobs`/`claimJobs` filter by **stage only**, not by source. When the
  `fetch_audio` lane runs, it claims that stage across **every** source. On
  2026-09-17 the customer-voicemail source's 1,888 fetch jobs (deferred because
  their budget was paused) kept getting claimed and re-deferred, which **starved
  the Yiddish24 download for ~2 hours**. The fix was to park the voicemail fetch
  jobs (`nextRunAt` far in the future). If the voicemail leg is revived, either
  give it a running budget so its jobs actually advance, or add a per-source
  filter to `claimJobs` first — otherwise it will starve Yiddish24 again.
- The engine has **no `transcribe`, `align` or `cluster` handler**, so this
  runner produces audio assets, segments and acoustic features only. No
  transcripts, vocabulary or pronunciation rules are learned yet. That is a
  separate build in `apps/api/src/yiddishCorpus`.
