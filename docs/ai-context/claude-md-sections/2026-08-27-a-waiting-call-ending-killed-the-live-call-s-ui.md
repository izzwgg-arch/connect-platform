# ⛔⛔ AGENT HANDOFF — a WAITING call ending killed the LIVE call's UI, DTMF stayed on the wrong speaker, the floating settings were CLIPPED, and the mini always opened dark (2026-08-27) — READ FIRST before touching useSipPhone's ended/failed handlers, before putting a popover inside `.fd-card`, before adding audio that must follow the call device, or for "the call timer stopped working"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`2ee9a614` on `feat/ivr-migration-takeover`. **portal DEPLOYED and
container-verified** — `.build-commit` = `2ee9a614`, all three survivor
predicates + `setSinkId` + `fd-settings-popover` + `viewport-dropdown` grepped
in the shipped chunks, 0 restarts, 0 error lines, both hostnames 200. **The
`apps/desktop` half is committed and rides the NEXT desktop release.** No api,
no worker, no migration, no PBX write.) Izzy, 2026-08-27, five reports in one
message. Memory: [[a-secondary-session-must-not-reset-the-live-call]].

- ⛔⛔ **THE HEADLINE, and it is the one that generalises: `useSipPhone`'s
  `session.on("ended"|"failed")` handlers ran the FULL top-level reset for ANY
  session** — `setCallState`, `setCallStartedAt(null)`, `sessionRef = null`,
  `stopLocalStream`, `teardownRemoteAudioPlayback`. The top-level single-call
  fields describe **the call the user is on**, so a SECONDARY session dying —
  a declined or abandoned **waiting call**, or a held call's far end hanging up
  — stomped a live conversation: **the mini's timer froze at 0:00**, the call
  screen dropped, and `removeSessionMeta`'s LIFO-restored `sessionRef` was
  nulled one line after it was set. ⛔ **It was always latent and the
  2026-08-20 call-waiting change is what made it routine** (secondary sessions
  became an everyday shape). ✅ Fixed with **survivor guards**: compute the
  connected/held sessions other than this one **BEFORE `removeSessionMeta`
  mutates the map**, and if any survive, sync the top-level state to the new
  active session and **return** instead of resetting. ⛔ **Ringing sessions are
  deliberately NOT survivors** — a leftover incoming ring never blocked the
  reset before, and treating it as live would wedge the dialer on-a-call.
- ⛔⛔ **THE HALF THAT IS EASY TO MISS: the primary's unconditional reset was
  ALSO what closed the loop when the whole call bundle ended.** Once survivors
  can take over, the LAST call can end on a **side** session — so
  `bindSideSession`'s `ended` AND `failed` both call
  `maybeTeardownTopLevelAfterSideEnd()`, which no-ops while any call is live
  and no-ops when the top level is already clear. **Without it the dialer stays
  stuck "on a call" forever.** A guard test counts both call sites.
- ⛔ **The failed-branch takeover sets NO error**: a waiting caller giving up is
  not a failure of the call the user is still on, and `setError` painted
  "Call failed" over a healthy conversation.
- ✅ **The mini's timer also gained a fallback** — `callStartedAt ?? the live
  session's own startedAt`. A timer anchored at session start is honest enough;
  a frozen 0:00 during a live call is not.
- ⛔ **DTMF played on the wrong speaker** because `playDtmfTone` never set a
  sink — the shared tone `AudioContext` kept whatever sink it last had (the OS
  default, or **the RINGER device** after a ring), while the call itself played
  on the headset. It now takes the call output device (`currentSinkIdRef`).
  ⛔ **The sink is applied ALWAYS, including `""` (OS default)** — the existing
  `applyCtxSink` helper skips on empty, which is correct for ringback and
  **wrong here**: skipping leaves the tone stranded on the ringer device.
- ⛔⛔ **A POPOVER INSIDE `.fd-card` CANNOT ESCAPE IT, AND `position: fixed`
  DOES NOT HELP.** The floating dialer's settings popover was clipped
  ("hidden underneath something") by `.fd-card { overflow: hidden }` — and the
  card's **`backdrop-filter`** plus the shell's **persistent `fdIn` animation
  transform** each make it a containing block, so fixed positioning and z-index
  are both defeated. ✅ It rides **ViewportDropdown** (portal to `<body>`) now.
  ⛔ **A body portal cannot see the `--fd-*` variables**, which live on
  `.fd-shell` — that is why it was also stuck dark; it themes itself through
  `:root[data-theme="light"] .fd-settings-popover …` rules, which DO reach a
  portal. Its surface rules need `!important` to beat globals.css's
  `.dropdown-panel` base, exactly as `.cs-panel` does.
- ⛔ **ViewportDropdown now ignores presses inside NESTED portaled panels** —
  without it, the ConnectSelects inside the newly-portaled popover would close
  it at pointerdown and lose the pick (the 2026-08-27 device-picker bug, one
  level down). Same rule as the section above; see
  [[portaled-dropdown-defeats-outside-close]].
- ⛔⛔ **THE MINI ALWAYS OPENED DARK, and the cause is in the SHELL, not the
  portal: `main.ts`'s in-memory `miniTheme` started `"dark"` on every app
  launch** and its `did-finish-load` handler **re-asserted that stale value**
  at the mini — correcting only once the full window's portal loaded and
  pushed, which with the full window hidden in the tray at boot can lag or
  never come. ✅ Three changes, and the portal-side two are what fix it TODAY:
  the mini reads the user's real choice from **shared `localStorage`
  `cc-theme`** (same-origin desktop windows share it — the reload broadcast and
  sign-in already rely on this, so no IPC needed), **defaults LIGHT** (the
  portal's own default — `useAppContext` is `useState("light")`; dark is opt-in
  everywhere), and **arbitrates every shell push against the store** so a stale
  re-assert can no longer flip it. The shell default also flips to light —
  ⏳ **that half ships with the next desktop release; the portal fix does not
  wait for it.**
- ✅ **Proven:** 8 source guards in `lib/dialerCallStateAndTheme.test.ts`
  (registered), **all 8 fail replayed against `HEAD`**; portal suite **372/374**
  (the two documented pre-existing failures); portal AND desktop typecheck 0.
  ⛔ **Verify this deploy by the minified survivor PREDICATE**
  (`grep -o 'connected"===[a-z]*\.state||"held"===[a-z]*\.state'`, expect **3**)
  — the variable names `survivorsOnEnd`/`liveTimerSession` are minified away and
  grepping them returns 0, which reads exactly like a failed deploy.
- ⏳ **NOT PROVEN: no human has been on a call since the deploy.** Acceptance,
  and the negatives matter most: (1) on a live call, let a SECOND call ring and
  decline it — **the timer must keep running and the call screen must stay**;
  (2) then hang up normally — the dialer must return to idle, **not** stay
  stuck on-a-call; (3) press keypad digits mid-call — the tone plays in the
  headset; (4) open the floating dialer's settings in the browser AND the
  Windows app — fully visible, and light in light mode; (5) open the mini —
  light unless the user chose dark. ⛔ An already-open desktop app keeps the
  OLD bundle until fully closed and reopened.
