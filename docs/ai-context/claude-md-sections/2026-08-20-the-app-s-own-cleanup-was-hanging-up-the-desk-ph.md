# ⛔⛔ AGENT HANDOFF — the app's own "cleanup" was HANGING UP THE DESK PHONE's live calls, and call waiting rang instead of beeping (2026-08-20) — READ FIRST for ANY "the call just dropped" report, before touching `stale-hangup-for-extension`, `useSipPhone.ts` or `useTelephonyAudio.ts`, and before scoping ANY hangup by extension number

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CALL_WAITING_AND_STALE_HANGUP_2026-08-20.md`**
(`2da67ab3` + `4e13522f` on `feat/ivr-migration-takeover`. No migration, no PBX
write, no env change, no tenant row touched. ✅ **BOTH HALVES DEPLOYED and
container-verified** — portal `2da67ab3`, telephony `4e13522f` (queue job
`0a0c65ab`), the latter in a **measured 0-active-call window**, AMI + ARI
reconnected, 0 restarts.)
Memory: [[stale-hangup-sweep-killed-desk-phone-calls]], [[call-waiting-must-beep-not-ring]].
Izzy relayed three complaints from Trust Bookkeepings ext 106; all three are real
and they are TWO defects.

- ⛔⛔ **THE HEADLINE: `POST /telephony/calls/stale-hangup-for-extension` picked
  which live calls to hang up by EXTENSION NUMBER, and an extension is shared by
  several devices** — `PJSIP/T18_106` is the DESK PHONE, `PJSIP/T18_106_1` is the
  portal. So a portal user pressing hangup/decline scheduled a sweep that **ten
  seconds later hung up the desk phone's live, answered, bridged call**, plus any
  other call on that extension. **Proven, not inferred: all 7 force-hangups in the
  telephony log were `PJSIP/T18_106-…` desk channels; not one was the portal's own
  leg.** Asterisk recorded it as `Manager 'connectcommsgefenu' from
  45.14.194.179, hanging up channel: …` — loopcom cutting off a live customer.
- ⛔ **THE CDRs LOOK PERFECTLY HEALTHY** (`disposition: answered`, sensible talk
  times) — nothing in call history hints the calls were cut off. The ONLY evidence
  is `zombie_force_evicted … reason:"stale-report from portal"` + `AMI Hangup sent`
  in `docker logs app-telephony-1`. **A "call just dropped" report with a clean CDR
  belongs in the telephony log, not the PBX.**
- ✅ **FIX: scoping moved to `apps/telephony/src/routes/staleHangupScope.ts`** —
  keyed on the caller's own PJSIP endpoint (`sipUsername`), matched **WHOLE**
  (⛔ `T18_106` is a PREFIX of `T18_106_1`; a prefix match IS the bug) against the
  call's **live** channels. ⛔ `call.channels` is pruned on Hangup
  (`CallStateStore.ts:1129`), which is what makes it correct — an inbound call that
  rang both devices and was answered on the DESK no longer carries the app's leg.
  ⛔ **FAILS CLOSED: no `sipUsername`, no eviction.** Not running leaves a cosmetic
  stale row in the live-calls list; running too broadly cuts a customer off
  mid-sentence. **Always pick the cosmetic failure here.** The portal also skips
  the sweep entirely while it still has other live sessions, re-checked at fire
  time. ⛔ **Never reintroduce a match on the extension number, `from` or `to`** —
  a source guard fails on all three old shapes.
- ⛔ **Defect B — call waiting played the FULL LOOPING RINGTONE over the live
  conversation.** The branch existed and was even labelled call-waiting; both arms
  called `startRingtone()`. ⛔ **It was in TWO places** — the primary UA *and*
  `startAccountEngine` (extra SIP accounts); fixing one is invisible in the other.
  Now `startCallWaitingAlert()` in `useTelephonyAudio.ts` mirrors the mobile app:
  **1400 Hz, 180 ms, repeating every 5 s**, no new audio asset (reuses
  `playToneBurst`). ⛔ **Stopping it is the half that bites** — the old version
  leaked (side-session `ended`/`failed` stopped no audio, so an abandoned waiting
  call rang to the 120 s cap). `settleCallWaitingAlert()` runs on
  `accepted`/`confirmed`/`ended`/`failed`, stops only when nothing else is waiting,
  and Decline passes its own id so the beep stops on the click rather than after
  the BYE. ✅ **The mini dialer needed no separate change** — one global
  `SipPhoneProvider` serves it, the full window and the desktop phone-engine page.
- **Tests: 17, all registered** (11 telephony incl. a replay of the real incident
  from the log; 6 portal — ⛔ the portal names every test file in `package.json`,
  so it had to be added there). ✅ **All 11 source guards fail when replayed
  against `HEAD`.** Portal typecheck 0; telephony **41 = its exact baseline**, none
  in an edited file; portal suite 229/231 (the two documented pre-existing fails).
  ⛔ The 3 `smarthome` telephony failures are pre-existing (identical with my
  changes stashed) and are a local-shell artifact — `src/config/env.ts` demands a
  32-char `JWT_SECRET`.
- ✅✅ **PROVEN LIVE ON PRODUCTION AFTER THE TELEPHONY DEPLOY, not just by test** —
  the route probed on the docker network: **no `sipUsername` → `{"cleared":0,
  "refused":"sip_username_required"}`**; correctly scoped → the route still works
  (`"No matching active calls found"`). ⛔⛔ **The refusal is the important half:
  every portal window still running the OLD bundle sends no `sipUsername`, so the
  desk-phone killing stopped platform-wide the moment telephony restarted — it did
  NOT wait for anyone to reload.** The BEEP, by contrast, reaches a window only
  after that window reloads.
- ✅ **Either deploy order was safe** (checked, not assumed): portal-first leaves the
  old telephony ignoring the unknown `sipUsername` field — the beep is fixed, the
  desk-phone drop is not, until telephony ships. Telephony-first makes the route
  refuse everything, which by itself stops the drops.
- ⏳ **NOT PROVEN: nobody has heard the beep**, and no human has been on a
  desk-phone call while someone hung up in the app since the deploy. Acceptance in
  §8 of the handoff — and ⛔ **the negative that matters most: the route must still
  clear a genuine phantom**, or the fix has simply broken the safeguard.
- ⚠️ **Noticed, NOT fixed:** `MultiCallPanel` is mounted only on the full softphone
  page, so `FloatingDialer` and `crm/live-call` now beep but show no call-waiting
  UI at all (product decision).
- ✅✅ **LAYER 2 (`14036cfe`, DEPLOYED + container-verified): THE ROUTE ASKS
  ASTERISK NOW, AND CAN NO LONGER HANG UP ANYTHING.** ⛔⛔ **It never checked
  staleness at all** — it ran on `callStore.getActive()`, whose own filter
  requires `state === "up"` and `hasValidBridgedParticipants`, i.e. the list of
  KNOWN-HEALTHY calls, and hung them up on the client's word.
  ⛔⛔ **THE COST, measured over 14 days of nginx logs: 303 sweeps, 242 answered
  "already gone", and ALL 9 that cleared something ended a REAL answered call —
  13 conversations across THREE customers (Fixup Group, Gesheft, Trust), one of
  them 551 s in. Zero genuine ghosts, ever.** ⛔ **It was NOT new** — a flat
  13–43 sweeps/day since at least 7 Aug; the first pass only looked new because
  the telephony container had been up 26 h. The 19–20 Aug burst was Trust's own
  desk-only call count going 0–3/day → **8 then 13**, i.e. more collisions, not a
  code change. ✅ **FIX:** `isCallLiveInAsterisk` applies
  `reconcileLiveChannels`' proven rule (a call is dead only when NONE of its
  channels are in ARI's raw `/channels`) — **Asterisk HAS it → leave it alone;
  Asterisk does NOT → evict the row.** ⛔⛔ **No AMI Hangup on that path ever
  again (`hangupChannel` is gone from it, guard-tested): a call Asterisk no
  longer has cannot be hung up, so the only thing a Hangup there can reach is a
  REAL call.** Store cleanup only; a genuinely stuck leg is a staff action via
  `DELETE /telephony/calls/:channelId/hangup`. Fails closed everywhere (no
  `sipUsername` → refuse; ARI unreachable → 503; liveness match fails toward
  "live"). ⛔ **The client path is REDUNDANT and now merely harmless** —
  `reconcileLiveChannels` is verified alive (Redis snapshot advanced
  23:32:31.628→23:32:36.627, `pollIntervalMs: 5000`) and clears a real ghost in
  ~10–15 s from ground truth. **That is the safety net; this route is not.**
  ⛔ The telephony container runs from **`src` via tsx — there is no `dist/`**,
  so verify by grepping `src`.
- ✅ **SAME COMMIT (`4e13522f`) — the update notice stopped nagging and the mini
  dialer got its own strip** (handoff §7b). Izzy: *"it keeps showing up again and
  again"*, and *"all they have open is the mini dialer"*. ⛔ **The repeat bug was a
  one-line omission: only the ✕ was recorded in `localStorage`; clicking Reload
  recorded NOTHING** — so a reload that failed to land the new bundle re-showed the
  notice every 5 minutes forever, with the button visibly not working. The build is
  acknowledged **BEFORE** the reload runs, and read **during render**, so it shows
  **at most once per deploy per profile**. ✅ New **`MiniDialerReloadBar`** — a 28px
  strip rendered **inside `.mini-shell` above the tab bar**; ⛔ **a flex child, never
  `position: fixed`** (a floating bar would sit on the dialpad and the call
  buttons), and the floating card stands down in the mini dialer so the two never
  both appear. ✅ **One click reloads every window** via the cross-window `storage`
  event (already relied on by `AuthGate.tsx:80-88`), so ⛔ **no desktop shell change
  and no installer release**. ⛔⛔ **A reload tears down the SIP softphone, so a
  window only auto-reloads itself when IDLE** — one on a call (incl. a proxy window
  mirroring the engine's call) ignores the broadcast and keeps its own notice; a
  window already on the new build ignores it too, so there is **no reload loop**.
  New `useOptionalSipPhone()` (chrome must never crash the app over a missing
  provider). 8 tests, registered; all 7 replayed against `HEAD` fail there.
  ⏳ **NOT PROVEN — and the strip cannot appear until a window has reloaded ONCE
  into this build**; an open window shows the OLD card for this deploy and the new
  strip only from the next one onward.
