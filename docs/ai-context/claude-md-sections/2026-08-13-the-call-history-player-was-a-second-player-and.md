# ⛔ AGENT HANDOFF — the Call History player was a SECOND player, and it never got the fix (2026-08-13) — READ FIRST for any "recording won't play / jumps back" report, before touching a portal recording player, or before adding a new one

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CALL_HISTORY_RECORDING_PLAYER_2026-08-13.md`**
(commits `033d0e6c` + `f95f7969` on `feat/ivr-migration-takeover` — portal
**DEPLOYED and container-verified**: new player chunk + spinner CSS grep'd
inside `app-portal-1`'s `.next`, and re-verified still present after the later
`e3744815` portal deploy.)

- ⛔ **THE RULE: the portal had TWO recording players, and the 2026-08-11
  spinner/honest-error fix landed on only one of them.** `CrmRecordingPlayer`
  (CRM timeline + both recordings pages) got it; the **Call History detail
  panel (`/calls`) had its own inline player with NONE of it** — a failed or
  slow `play()` silently snapped the button back. Izzy's "I was told this was
  fixed and it was not" was literally true — fixed on the player he doesn't
  use. Same family as the two IVR publish paths: find EVERY player before
  believing a playback feature is live.
- **All playback now goes through `apps/portal/services/recordingPlayback.ts`**
  — single stream/download URL builder + one-byte failure classifier
  (`not_recorded` / `forbidden` / `temporary`). ⛔ Any NEW recording player
  must use it; `git grep "voice/recording/" apps/portal` — only
  `recordingPlayback.ts` and `recordingDownload.ts` may build those URLs.
- **The `/calls` player now:** spinner + "Loading…" the moment play needs a
  network fetch; "This call wasn't recorded" REPLACES the player on a
  confirmed-permanent 404; transient failure shows Try-again — ⛔ retries are
  USER-initiated only (an auto-retry loop against a dead recording is the
  exact flood that once wedged the PBX helper); 45 s stall watchdog; CDR
  talk-time as the duration until audio metadata arrives (kills 0:00/0:00);
  Download switched from a bare `<a>` (which silently saved JSON error bodies
  as `.wav`) to `downloadRecordingWithReason`.
- **Fleet sweep of dead play buttons** (dry-run first: **9 of the newest 60
  advertised recordings don't exist**). Runner `/root/recording-verify-sweep.js`
  on loopcom mints an in-container SUPER_ADMIN service JWT and drives the real
  `POST /voice/recordings/verify` (`docker exec -i app-api-1 node /tmp/rvs.js
  '{"dryRun":false,"limit":5000}'`). Two traps, both paid for:
  ⛔ **node's `fetch` kills the client at 5 minutes** (undici headers timeout)
  — "ERR fetch failed" while the route handler KEEPS RUNNING server-side; the
  script now uses `node:http` (no timeout). ⛔ **an api deploy recreating
  `app-api-1` kills the in-process sweep handler AND wipes `docker logs`** —
  a missing completion line proves nothing; judge progress by
  `count(recordingMissingAt not null)`. Pass 1 stamped **752 dead buttons
  (186 → 938)** before the 14:52Z deploy killed it; the retry loop
  (`/root/recording-verify-loop.sh`, log `/root/recording-verify-loop.log`)
  then **COMPLETED on attempt 2, 2026-08-13 21:28 CEST**:
  **5,000 checked → 4,354 real, 643 stamped dead, 3 RECOVERED** (queue/IVR
  leg-drift paths self-healed, so those three now play), 0 skipped.
  **Fleet total 186 → 1,666 dead play buttons removed in one day —
  ~13% of everything the newest 5,000 rows advertised.** Stamps are
  idempotent and cumulative; history deeper than that cleans up honestly per
  click. ⛔ **Do not "reset" a stamp to re-test** — the sweep is the same
  resolve→fetch→recover chain a click uses, and `recovered: 3` is the proof it
  cannot hide a playable recording. Reversal, if ever needed, is
  `update "ConnectCdr" set "recordingMissingAt" = null`.
- ⏳ **NOT PROVEN:** nobody has pressed play on the new player in a real
  browser. Open windows/desktop installs keep the old bundle until reloaded
  (the reload banner appears within ~5 min).
