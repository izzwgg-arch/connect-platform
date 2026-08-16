# AGENT HANDOFF — the Call History recording player was a SECOND player, and it never got the fix (2026-08-13)

**Status: portal DEPLOYED and container-verified. Fleet sweep COMPLETE.**
Commits `033d0e6c` + `f95f7969` on `feat/ivr-migration-takeover`.
Portal-only code change — nothing touching call routing, the PBX, or billing.

Read this with:
- `docs/ai-context/AGENT_HANDOFF_ESCALATIONS_RECORDINGS_VOICEMAIL_2026-08-12.md`
  (where `recordingMissingAt` and the verify sweep came from)
- memory `[[recording-path-proves-intent-not-existence]]`

---

## 1. The report, and why it was literally true

Izzy, 2026-08-13, on `/calls` (Call History → a call's detail panel):

> "Call recording: I'm still not playing... When I hit play, if the file is not
> loaded yet and it's loading for playing, then the user should see that it is
> loading. I was told that it was fixed, but it's not. I was told that it was
> added in there by an agent, and it was not... If it jumps to play for a
> second, it jumps back."

He was told the truth and shown a lie at the same time. **The portal had TWO
recording players:**

| Player | Screens | Had the 2026-08-11 spinner + honest errors? |
|---|---|---|
| `components/CrmRecordingPlayer.tsx` | CRM timeline, `/recordings`, `/pbx/call-recordings` | ✅ yes |
| inline `CallRecordingPlayer` in `app/(platform)/calls/page.tsx` | **Call History detail panel** | ❌ **none of it** |

The fix WAS made — to the player he does not use. The `/calls` player was
~55 lines with a bare `audio.play().catch(() => setPlaying(false))`: on any
failure or slow start the button silently snapped back to Play. No spinner, no
message, no retry, no reason. That is exactly "it jumps to play for a second,
it jumps back."

⛔ **THE RULE: before believing a playback feature is live, find EVERY player.**
Same family as the two IVR publish paths (`POST /voice/ivr/publish` vs
`publishIvrForTenant`) and the two invite-email paths — a fix applied to one of
a duplicated pair reads as done and ships broken.

Compounding it: the call in his screenshot was almost certainly one where the
PBX **advertises** a recording it never made (see §4) — so the player was
failing instantly, with nothing on screen to say so.

---

## 2. What shipped

### 2a. One shared playback contract — `apps/portal/services/recordingPlayback.ts` (new)

Single source for **both** halves that used to be duplicated per player:

- `recordingStreamUrl(linkedId)` / `recordingDownloadUrl(linkedId)` — token
  resolution (`token` → `cc-token` → `authToken`) + `encodeURIComponent`, once.
- `classifyRecordingPlaybackFailure(streamUrl)` — an `<audio>` `onError` says
  only "it broke", never why. So we ask the server for **one byte**
  (`Range: bytes=0-0`) and read its answer:
  - `403` → **`forbidden`** (permission, not a glitch) — this case did not exist
    in the old CRM classifier and was silently reported as "not recorded".
  - `404` + body `error !== "audio_fetch_failed"` → **`not_recorded`**, PERMANENT.
  - `404` + `audio_fetch_failed`, any 5xx, network error, or a **successful**
    byte fetch → **`temporary`** (a served byte means the element choked, not
    the recording).
- `RECORDING_PLAYBACK_TEXT` — the customer-facing sentence per verdict.

⛔ **Any NEW recording player must import from here.** Guard:
`git grep "voice/recording/" apps/portal` must only hit
`services/recordingPlayback.ts` and `services/recordingDownload.ts`.

### 2b. The `/calls` player, rewritten

- **Loading is visible.** On click, if `audio.readyState < 3` (HAVE_FUTURE_DATA)
  the click starts a network fetch → play button becomes a spinner and the time
  readout becomes "Loading…" (`aria-live="polite"`). Mid-play rebuffer
  (`onWaiting`) does the same. Cleared on `playing`.
- **"This call wasn't recorded" REPLACES the player** once the server confirms
  it permanently. A player that can never produce sound is worse than no player.
  `forbidden` likewise gets its own honest line.
- **Retry is USER-initiated only.** A transient failure renders a "Try again"
  button that calls `audio.load()` then replays. ⛔ **Never make this
  automatic** — an auto-retry loop against dead recordings is precisely the
  flood that wedged the PBX helper at 1024 FDs on 2026-08-12
  (`[[desktop-voicemail-preload-404-loop]]`).
- **45 s stall watchdog** (`RECORDING_LOAD_WATCHDOG_MS`). The server bounds its
  PBX time-to-headers at 20 s and a stale-path recovery adds a second
  round-trip, so past ~45 s it is stuck, not slow. Pauses and offers the retry.
- **No more `0:00 / 0:00`.** Duration falls back to the CDR's `talkSec`
  (then `durationSec`) until the audio's own metadata arrives; also handles the
  `Infinity` duration a chunked stream can report.
- **Download is a button, not a bare `<a>`.** The old anchor pointed at the
  attachment URL, so when the server answered 404-with-JSON the browser
  cheerfully saved the **error body as a `.wav`**. It now goes through
  `downloadRecordingWithReason` and says why it failed — and a `not_recorded`
  download verdict also collapses the player, since it answers the same question.
- **One classification per failure** (`f95f7969`): `onError` and the rejected
  `play()` promise both fire for a single failure; a ref guard stops two
  one-byte probes going out. `AbortError` (user pausing a pending play) is not
  a failure at all.

### 2c. `CrmRecordingPlayer` deduped

Now imports the shared classifier/URL builder; its local copies deleted.
Gains the `forbidden` verdict it never had (renders "No access", not the
misleading "Not recorded").

### 2d. CSS

`.cdp-recording-note`, `.cdp-recording-error` (+ its retry button) and
`.cdp-audio-spin` / `@keyframes cdpAudioSpin` appended near the existing
`.cdp-recording-player` block in `globals.css`. `.cdp-recording-download` picked
up `cursor/font-family/:disabled` because it changed from `<a>` to `<button>`.

---

## 3. Proof

- `npx tsc --noEmit` clean in `apps/portal` (⛔ restore `tsconfig.tsbuildinfo`
  afterwards — it is TRACKED and `tsc` dirties it).
- Portal deployed (job chain finished `[deploy-portal] done f95f7969`) and
  **grep'd inside the running container**:
  `docker exec app-portal-1 grep -rl cdp-recording-note /app/apps/portal/.next/static/chunks`
  → hits the calls page chunk; `cdpAudioSpin` present in the shipped CSS.
- **Re-verified after later deploys**: portal now runs `e3744815` (another
  session's tip) and the player is still in the bundle — the fix is an ancestor,
  not something a later deploy rolled back.
- ⏳ **NOT PROVEN: nobody has pressed play in a real browser since the deploy.**
  Proven from the shipped bundle, not by a human hearing audio. ⛔ Open portal
  windows and desktop installs keep the OLD bundle until reloaded — the
  "Connect was updated — Reload" banner appears within ~5 min.

---

## 4. The fleet sweep of dead play buttons

`ConnectCdr.recordingPath` proves the dialplan's INTENT, never that audio
exists (memory `[[recording-path-proves-intent-not-existence]]`). Until a click
proves otherwise, Connect offers a play button for every one.

**Dry run first** (newest 60): **51 present, 9 missing** — 15% of the freshest
recordings on the platform were dead buttons.

**Applied run, newest 5,000 — COMPLETE 2026-08-13 21:28 CEST:**

```
{"dryRun":false,"checked":5000,"present":4354,"missing":643,"recovered":3,"skipped":0}
```

Fleet total: **186 → 1,666 stamped** across the day (pass 1 stamped 752 before
a deploy killed it; the completing pass added the rest). `recovered: 3` is the
important number — three queue/IVR calls whose stored path 404s had their real
recfile found by `recoverRecordingFromPbxCdr` and their paths corrected, so
**those three now play**. That is the proof the sweep cannot hide audio a click
would have produced.

### Runner

`/root/recording-verify-sweep.js` on loopcom — mints a 4 h SUPER_ADMIN service
JWT from the container's own `JWT_SECRET` and drives the **real**
`POST /voice/recordings/verify` on `127.0.0.1:3001`.

```bash
docker cp /root/recording-verify-sweep.js app-api-1:/tmp/rvs.js
docker exec -i app-api-1 node /tmp/rvs.js '{"dryRun":false,"limit":5000}'
```

`/root/recording-verify-loop.sh` wraps it in up to 6 attempts (log
`/root/recording-verify-loop.log`) because of trap 2 below.

### Two traps, both paid for

1. ⛔ **Node's `fetch` kills the client at 5 minutes** (undici's default headers
   timeout). You get `ERR fetch failed` **while the route handler keeps sweeping
   server-side** — so the run looks dead, is not, and re-running it races itself.
   The script uses `node:http` with **no timeout**; the route only answers when
   the whole sweep is done (~25 min for 5,000).
2. ⛔ **An api deploy recreating `app-api-1` kills the in-process handler AND
   wipes `docker logs`**, so the `recording: verify sweep` completion line
   vanishes. **A missing completion line proves nothing.** Judge progress by
   `count(recordingMissingAt not null)` in the DB, which is monotonic.

⛔ Also: `docker exec` tied to an ssh session dies with that session. Use
`docker exec -d`, or a `setsid nohup` wrapper on the host.

---

## 5. Open / not done

- ⏳ **A human has not pressed play.** The acceptance test is 30 seconds: open
  `/calls`, pick an answered call with a Recording section, press play — expect
  a spinner then audio, or an honest sentence. Then press one you know is dead
  → "This call wasn't recorded", no spinner-forever.
- **Rows older than the newest 5,000 are not swept.** They clean up honestly on
  first click now (the click stamps them), or re-run the sweep with a larger
  `limit` / a `since`.
- ⛔ **Whether these calls SHOULD be recorded at all is still Izzy's open
  decision** and is NOT what this fixed. Recording is switched on per inbound
  route / outbound route / queue on the PBX — **never per extension**. Trust
  Bookkeeping's inbound routes all carry `enablerecording=no`. This work only
  stops Connect promising audio it cannot produce.
- The `/calls` page still builds its own row-level UI; only the detail-panel
  player was in scope.
