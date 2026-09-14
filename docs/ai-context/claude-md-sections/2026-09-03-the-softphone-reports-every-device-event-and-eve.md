# ⛔⛔ AGENT HANDOFF — the softphone REPORTS EVERY DEVICE EVENT AND EVERY PRESS now: read `/admin/call-timeline` BEFORE asking for a screen share (2026-09-03, `762d055f`) — READ FIRST for ANY "I can't hear / they can't hear me" ticket, before touching `applySink`/`refreshAudioDevices`/`attachRemoteStream` in `useSipPhone.ts`, before adding a diag fetch to the portal, or before adding a fact the client should record

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SOFTPHONE_CLIENT_TRACE_2026-09-03.md`**
(`762d055f` on `feat/ivr-migration-takeover` — api + portal + one migration.
✅ **api DEPLOYED and container-verified** (`.build-commit` = `762d055f`, migration
`20260903180000_voice_diag_client_trace` applied 00:39:18Z and read back from `pg_enum`,
0 restarts, 0 error lines, health 200 + unauthenticated batch POST 401 on both
hostnames) **and PROVEN ON PRODUCTION by driving the route** — 400 / 404 / 200
`stored:4 dropped:1` / 429 at the 21st batch / stale timestamp clamped / forged identity
keys ignored / 23 rows read back through the admin timeline, then every probe row
deleted. Portal deploy state: end of this section. No PBX write, no env change, no
customer row touched.) Memory: [[softphone-client-trace-reports-every-press]].
Izzy, 2026-09-03: *"Stop sending me to her fucking screen… You should be able to see the
logs on every little press, everything that happens on their Windows app… Build me a
reporting system on those apps."* — *"something that's actually gonna work, not some
half-assed broken shit."*

- ⛔⛔ **WHY IT WAS UNDIAGNOSABLE FROM THE SERVER:** the web/desktop softphone
  (`useSipPhone.ts` — the Windows app loads the hosted portal) recorded NOTHING about
  devices. `preferHeadsetDevice` auto-picks the MIC by label and never the SPEAKER
  (that split IS the "caller hears me, I don't hear the caller" family); `applySink`
  swallowed a `setSinkId` rejection in a bare catch, so a headset chosen in the UI that
  the browser refused looked identical to one that worked; `remoteAudioReceiving` in the
  end-of-call report was read AFTER teardown reset it (**false in 53/53 web reports**);
  `lastCallError` was never sent. Every headset ticket ended in AnyDesk.
- ✅ **ONE new event type, `VoiceDiagEventType.CLIENT_TRACE`, structured by
  `payload.kind`** — the allowlist in `apps/api/src/voice/clientTraceBatch.ts` IS the
  schema (`device_inventory`, `mic_auto_picked` with the speaker it was NOT paired with,
  `mic/speaker/ringer_selected` + `_failed`, `mic_opened` with the TRACK's real label,
  `remote_audio_attached` with the element's REAL `sinkId` + `play()` outcome,
  `remote_audio_play_blocked`, `one_way_audio`, `incoming_audio_resumed`,
  `remote_track_*`, `call_end`, `reg_state`, `press`, `settings_opened`). ⛔ **A new
  fact goes into that list first or the server DROPS it — and counts it** (`dropped` in
  the response + an api warn line), so a client bug is visible, never silent. No new
  enum value, no migration for the next fact.
- ⛔⛔ **NEVER ONE REQUEST PER EVENT, NEVER WHILE SIGNED OUT.** `apps/portal/lib/clientTrace.ts`
  is the only door: ring buffer capped 300, batches of 50, 2.5 s debounce, keepalive
  flush on `pagehide`/hidden, a failed send puts the chunk BACK and stops (no retry
  loop), and nothing is sent without a token (`peekBrowserAuthToken`). A per-press
  `fetch` from a device-change storm is the exact shape that got a whole office
  auto-banned at nginx. One diag session per window (`lib/voiceDiagSession.ts`,
  sessionStorage) — the hook's private `diagSessionPromise` is gone.
- ⛔ **Server side `POST /voice/diag/events`** sits INSIDE the `/voice/diag` block so the
  existing self-report guard covers it: identity from the TOKEN, the session must be the
  caller's (404), 50 rows/batch (overflow counted), **20 batches/min per session**
  (separate from single events), every row through `sanitizeDiagPayload`, a timestamp
  >15 min old or >60 s ahead is stamped `now` (a buffer replayed after a laptop sleep
  cannot land in the past). ⛔ `trimValue` nesting is 3 — facts → device list →
  `{id,label}`; depth 2 EMPTIES the inventory (the test caught it).
- ⛔ **No phone numbers, no DTMF digits.** `press` for dial carries a digit COUNT,
  `dtmf` carries no digit; facts are labels, 8-char ids, counts, error NAMES, booleans.
- ⛔ **The quality-report schema now NAMES `lastCallError`, `micLabel/micId`,
  `speakerLabel/speakerId`, `speakerOn`** — zod strips what it does not name (the
  `pageSize` trap); `remoteAudioReceiving` reads `remoteAudioSeenRef`, never `diag.*`.
  Timeline include `take` 200 → 600, or the chatty trace truncates the event that
  explains the ticket.
- ✅ **How to use it:** `/admin/call-timeline` → search the login email → read the
  **Devices** card first (last mic vs last speaker; a headset mic beside a "Speakers
  (Realtek…)" speaker is the whole one-way-audio diagnosis; red *speaker selection
  failed* = the UI said headset and the browser refused) → then
  `remote_audio_attached` (the REAL sink), `remote_audio_play_blocked`, the presses in
  order, and `call_end`'s `lastCallError`.
- ⛔ **An already-open desktop app or tab records NOTHING until fully closed and
  reopened** (old bundle). A customer session with zero CLIENT_TRACE rows after the
  deploy is on the old bundle, not broken.
- ✅ **Proven:** api 20/20 (`clientTraceBatch.test.ts` 7 + `voiceDiagClientTrace.test.ts`
  source guards, **5/6 fail replayed against HEAD**; the self-report guard still green
  over the new route), portal 17/17 (`clientTrace.test.ts` + `clientTraceWiring.test.ts`,
  **9/9 wiring guards fail against HEAD**), portal typecheck 0, api 81 = baseline.
  ⛔ Two harness traps: node 24's `navigator` global is getter-only
  (`Object.defineProperty`), and a wiring guard's end marker must be CODE — the
  guard's own comment-stripper removes a comment-line marker.
- ⏳ **NOT PROVEN YET: no CUSTOMER window has produced a CLIENT_TRACE row** — that
  needs the portal deploy (below) AND the person to fully restart the app. Acceptance:
  after the portal is live, the next call from any restarted desktop app shows a
  Devices card and press rows on `/admin/call-timeline`; the negative that matters:
  no `/voice/diag/events` traffic from a signed-out window.
- ⏳ **Deliberately NOT built:** auto-pairing the speaker with the auto-picked headset
  mic (the product fix the data points at — changes call audio for everybody, Izzy's
  call); surfacing the `setSinkId` failure IN the UI; desktop shell log upload
  (`shell_info` reserved); Windows' own Bluetooth Stereo↔Hands-Free profile flip
  (invisible to the browser; the label carrying "(Hands-Free)" is the tell).
- ✅✅ **ROUND TWO, SAME DAY (`7f73086a`, handoff §9) — "in whatever you said that's not
  built yet, build it, commit, push, install, and deploy it all." api + portal DEPLOYED and
  container-verified at `7f73086a`; desktop `Connect-Setup-0.1.17-rc.9.exe` BUILT,
  icon-verified and INSTALLED on Izzy's workstation (⛔ NOT published — the feed stays
  0.1.16 and rc.9 carries other sessions' unpublished work).** What it adds:
  **(1) `media_sample` every 10 s of a call** — packet deltas, loss, jitter, RTT, ICE path
  and **audio LEVELS both ways** (RMS from getStats energy deltas; silence < 0.004).
  **(2) A server-authored per-call `verdict`** (`voice/callVerdict.ts`, pure, 11 tests),
  stored the moment a `call_end` batch lands, ladder `mic_open_failed > playback_blocked >
  speaker_apply_failed > no_inbound_rtp > inbound_silent > mic_silent > remote_track_lost >
  split_devices > poor_network > ok` (+ `short_call` / `no_data`); ⛔ `verdict` is
  SERVER-ONLY — a client batch carrying it is dropped and counted (proven live). Shown at
  the top of the Devices card. **(3) The support watcher reads it first** — MCP tool
  `get_call_diagnostics` on the allowlist + prompt rule; ⛔ never edit
  `.watch-state.json` while the watcher runs (it rewrites from memory), and
  `Stop-ScheduledTask` did NOT stop the old `node watch.mjs` — kill the tree, start the
  task, look for a fresh `==== started` banner. **(4) Desktop shell log** —
  `connectDesktop.diagnostics.{info,shellLogTail}`, a BOUNDED tail of `connect.log`
  clamped in main (≤ 60 lines / 300 chars / 15 min; the page names no file), traced as
  `shell_info` per window + `shell_log` at call end. **(5) The update strip people act
  on** — measured ~4,100 `/version` polls and ONE reload overnight: the ✕ is a 1-hour
  SNOOZE now, an idle window (no call, no input 20 min) reloads ITSELF, wording says what
  to do; ⛔ it takes TWO deploys to reach a window still on the pre-`762d055f` bundle.
  **(6) Fixes from the first real rows** (Ezra, 527): `reg_state` coalesced to one row a
  minute with a change count (518 of 527 were flaps); a mount-time speaker apply resolves
  its label lazily (was "(unnamed 9cc05138)").
  ✅ **PROVEN:** production probe → `split_devices` / `no_inbound_rtp` / `ok`, one
  server row each, admin timeline returns it, forged verdict dropped; **this
  workstation's rc.9 app on the new bundle wrote `shell_info` + a real device inventory
  within 4 s**; the restarted watcher retried Y7FK8P / UVW3Y7 / 47CUTJ (the bounded retry,
  live for the first time) and on UVW3Y7 **called `get_call_diagnostics` first and wrote
  "that window was never restarted" instead of asking for a screen**. Suites: api 31/31,
  portal 27/27, desktop 235/235, MCP 50/50; typechecks portal/desktop 0, api 81 = baseline.
  ⏳ **NOT PROVEN: no customer call has produced a `media_sample` or `verdict` yet** (needs
  a customer window on the new bundle + a call ≥ 10 s); no real `shell_log`; the idle
  self-reload has not been seen firing. Auto-pairing the speaker with the auto-picked
  headset mic (the product fix the data points at) is still Izzy's call.
