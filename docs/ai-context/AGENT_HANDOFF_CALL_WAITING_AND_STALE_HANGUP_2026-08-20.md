# AGENT HANDOFF — the Windows/browser app rang over live calls, and its "cleanup" hung up the desk phone (2026-08-20)

**Read this before touching `apps/portal/hooks/useSipPhone.ts`, `useTelephonyAudio.ts`,
`POST /telephony/calls/stale-hangup-for-extension`, or before investigating ANY
"the call just dropped" report.**

Commit `2da67ab3` on `feat/ivr-migration-takeover`.
**No migration, no PBX write, no env change, no tenant row touched.**
Deploy state in §7 — ⛔ the telephony half is the one that stops the call drops
and it needs a quiet window.

Izzy, 2026-08-20, relaying customer complaints:
1. *"If they're on an existing call and there's another incoming call, the call
   just starts ringing… It shouldn't ring. It just disturbs the person."*
2. *"With the Trust bookkeeping extension 106, when she's getting another call
   while she's on a call, this [dis]connects."*
3. *"Later on it started happening on the hard phone as well. When they started
   getting a call on the hard phone, the call disconnected."*

**All three are real. They are TWO defects, and #2 and #3 are the same one.**

---

## 1. The headline

⛔⛔ **The portal's post-hangup "stale call" cleanup was hanging up the DESK
PHONE's live, answered, bridged calls.** It selected which calls to kill by
**extension number** — and an extension is shared by several devices:

```
PJSIP/T18_106      ← the desk phone       (UDP 5060)
PJSIP/T18_106_1    ← the portal / web app (WebRTC over wss)
```

So when a portal user pressed hangup/decline, the app scheduled a sweep that
ten seconds later told the PBX to hang up **every** live call on extension 106
— including the one the person at the desk phone was in the middle of.

**Measured, not inferred.** Every force-hangup in the telephony log was a desk
channel; not one was the portal's own leg:

```
$ docker logs app-telephony-1 --since 2026-08-13 | grep zombie_force_evicted \
    | grep stale-report | grep -oE "PJSIP/T[0-9]+_[0-9]+(_1)?-[0-9a-f]+"
  1 PJSIP/T18_106-0000093b
  1 PJSIP/T18_106-0000093e
  1 PJSIP/T18_106-00000951
  1 PJSIP/T18_106-00000955
  1 PJSIP/T18_106-0000096f
  1 PJSIP/T18_106-00019aa5
  1 PJSIP/T18_106-00019aab
```

7 for 7 desk channels. The portal's own `T18_106_1` calls ended normally and
were never swept — which is exactly why this reads as "the phone system
randomly drops calls" and never as an app bug.

---

## 2. The incident, second by second (2026-08-20, EDT — the PBX runs EDT)

Trust Bookkeepings, PBX tenant **18**, Connect tenant
`cmnlgrykx000fp9pa90gohk96`.

| Time | What happened |
|---|---|
| 13:31:06 | Desk phone dials 347-768-1172 — `PJSIP/T18_106-0000093b`, answered 13:31:13 |
| 13:31:38 | Desk phone dials 347-228-2898 — `PJSIP/T18_106-0000093e`, answered 13:31:45 |
| 13:31:18 / 13:31:32 | `Hold` events on 0000093b — one call held, one active. Normal two-line desk working. |
| 13:33:59 | An inbound queue call rings ext 106 (both devices). Asterisk marks 106 **BUSY** and plays `busy.slin`. |
| ~13:34:03 | **Someone hangs up / declines in the app.** `hangup()` schedules the stale sweep for extension 106. |
| 13:34:13 | Portal POSTs `stale-hangup-for-extension {extension: "106"}`. Telephony force-evicts **both desk calls** and sends 4 AMI Hangups. |

Asterisk's own record of the kill:

```
[13:34:13] manager.c: Manager 'connectcommsgefenu' from 45.14.194.179,
           hanging up channel: PJSIP/T18_106-0000093b
           hanging up channel: PJSIP/0001-0000093c
           hanging up channel: PJSIP/T18_106-0000093e
           hanging up channel: PJSIP/0001-0000093f
```

`45.14.194.179` is loopcom — **we did this to them.** Both parties heard the
call end mid-sentence. It repeated at 13:36:41 and 13:38:16, and on 2026-08-19
at 21:01.

⛔ **The CDRs look perfectly healthy** — `disposition: answered`, sensible
talk times. Nothing in call history hints that the calls were cut off. The only
evidence is the `zombie_force_evicted` / `AMI Hangup sent` pair in the
telephony log.

---

## 3. Defect A — call waiting played the full ringtone

`apps/portal/hooks/useSipPhone.ts` had the branch, and it was even *labelled*
call-waiting — but both arms called the same function:

```ts
if (!sessionRef.current || sessionRef.current.isEnded?.()) {
  …
  startRingtone();     // idle — correct
} else {
  bindSideSession(data.session, party, mcId);
  startRingtone();     // ⛔ full looping ringtone OVER a live conversation
}
```

⛔ **It was in TWO places** — the primary UA *and* `startAccountEngine` (the
extra-SIP-account path). Fixing one is invisible in the other; this is the
recurring defect shape in this repo, so the guard test asserts on both.

The mobile app has always done this correctly
(`apps/mobile/src/audio/telephonyAudio.ts`): one short bright beep, repeating,
never the ringtone. The portal now mirrors it —
`startCallWaitingAlert()` / `stopCallWaitingAlert()` in `useTelephonyAudio.ts`:
**1400 Hz, 180 ms, repeating every 5 s**, idempotent, honouring the existing
ringer volume/output-device preferences.

⛔ **No new audio asset.** It reuses the existing `playToneBurst` Web Audio
helper, exactly as mobile synthesises its beep rather than shipping a file.

**Stopping it is the half that bites.** The old ringtone version leaked: the
side-session `ended`/`failed` handlers never stopped audio, so an abandoned
waiting call rang until the 120 s absolute cap. Now `settleCallWaitingAlert()`
runs on `accepted`, `confirmed`, `ended` and `failed`, and only stops when **no
other waiting call is still ringing**. `stopAll()` also clears the timer, so no
path can strand it.

⛔ `hangupSession` (Decline) passes the declined id to
`settleCallWaitingAlert(id)` — that session's meta is only removed later by its
own async `ended` handler, so without the exclusion the beep kept going for the
length of the BYE round-trip after the user clicked Decline.

✅ **The mini dialer needed no change of its own.** There is ONE global
`SipPhoneProvider`, so the mini dialer, the full portal window and the desktop
phone-engine page all share the single hook instance — fixing `useSipPhone.ts`
fixes all three. Its call-waiting strip already used the correct per-session
`answerSession` / `hangupSession` actions.

---

## 4. Defect B — the stale-hangup sweep (the call drops)

### What the route is for
`POST /telephony/calls/stale-hangup-for-extension` is a last-resort cleanup: if
JsSIP sent BYE but the PBX never delivered an AMI Hangup, a phantom "live call"
row is left in the live-calls UI. Ten seconds after a hangup the portal asks the
telephony service to clear it.

### Why it was dangerous
The only filters were **extension number** and a 2-second age floor:

```ts
const matchesExt =
  (c.from && (c.from === extension || c.from.endsWith(`/${extension}`))) ||
  (c.to   && (c.to   === extension || c.to.endsWith(`/${extension}`)));
```

Outbound calls carry `from: "106"` whichever device placed them, so this matched
the desk phone, the app, and every concurrent call equally. It was written when
one extension meant one call on one device; multi-call and a desk phone sharing
the extension both invalidate it.

### The fix
Scoping moved into a pure, tested module,
**`apps/telephony/src/routes/staleHangupScope.ts`**:

- The caller must send **`sipUsername`** — its own PJSIP endpoint (`T18_106_1`).
- A call is a candidate **only if that endpoint is one of its LIVE channels**.
  ⛔ `call.channels` is *pruned on Hangup* (`CallStateStore.ts:1129`), which is
  what makes this correct: an inbound call that rang both devices and was
  answered on the DESK no longer carries the app's leg, so the app cannot claim
  it.
- The endpoint is matched **WHOLE**, never as a prefix — `T18_106` is a prefix
  of `T18_106_1`, and a prefix match is the bug itself.
- ⛔ **Fails CLOSED.** No `sipUsername` → evict nothing, log a warning, return
  `{cleared: 0, refused: "sip_username_required"}`. Not running leaves a stale
  row in a list (cosmetic); running too broadly cuts a customer off mid-sentence
  (not recoverable). **Always pick the cosmetic failure here.**

Portal side, two guards:
1. It sends `sipUsername` (`diagRef.current.sipUsername`).
2. It **skips the sweep entirely while it still has other live sessions**, and
   re-checks at fire time in case a new call started during the 10 s wait.

⛔ **Never reintroduce a match on the extension number, `from`, or `to`.** Those
are shared by every device on the extension. A guard test reads the route's
source (comments stripped) and fails if any of the three old shapes returns.

---

## 5. Where the SIP identity comes from

`resolveWebrtcSipIdentity` (`apps/api/src/voiceProvisioningBundle.ts`) prefers
`pbxDeviceName`. Live values for Trust Bookkeepings:

```
106 | sipUsername: 106_1 | deviceName: T18_106_1 | webrtc: true
101 | sipUsername: 101_1 | deviceName: T18_101_1 | webrtc: true
389 | sipUsername: 389   | deviceName: T18_      | webrtc: false
```

So the portal registers as `T18_106_1` and `diagRef.current.sipUsername` is
exactly the endpoint half of the channel name. ⛔ Note rows 389/662 have a
truncated `T18_` deviceName and `webrtc: false` — those are non-WebRTC
extensions and never call this route; don't "fix" them on this evidence.

---

## 6. Tests

**17 new, all registered.**

- `apps/telephony/src/routes/staleHangupScope.test.ts` — **11 tests**, picked up
  by the existing `src/routes/*.test.ts` glob (no registration needed). Includes
  a **replay of the real incident** using the two desk calls from the log, plus:
  fails-closed without `sipUsername`; whole-not-prefix endpoint matching; a
  losing ring leg doesn't make the call ours; the user's NEXT call is never
  swept; the 2 s floor at its boundary; another tenant's call untouched; and the
  route's own orphaned call **is** still cleaned up (the route must not become a
  no-op).
- `apps/portal/lib/callWaitingAlert.test.ts` — **6 tests**. ⛔ The portal names
  every test file explicitly in `package.json`; this one was **added to that
  list** or it would never have run.

✅ **All 11 source guards were replayed against `HEAD` and all 11 fail there** —
proven non-vacuous, not decorative.

⛔ Comments are stripped before every negative match: the doc blocks deliberately
quote the old broken code, and a naive `includes()` fires on the explanation.

**Baselines held:** portal typecheck **0**; telephony **41 = its exact
pre-existing baseline**, none in an edited file. Portal suite **229/231** (the
two documented pre-existing failures). Telephony suite: the 3 `smarthome`
failures are pre-existing and identical with my changes stashed — ⛔ they and
`requeueLiveCallGate` fail locally only because `src/config/env.ts` demands a
32-char `JWT_SECRET`; that is a local-shell artifact, not a regression.

---

## 7. Deploy state ✅ BOTH HALVES ARE LIVE

| Half | State |
|---|---|
| **portal** (the beep + sends `sipUsername` + skips the sweep while other calls are live) | ✅ **DEPLOYED + container-verified** `2da67ab3` — `.build-commit` matches, and the strings `stale-hangup sweep skipped`, `sipUsername`, `call_waiting incoming` all grep inside the shipped `.next` chunks |
| **telephony** (the half that stops the desk-phone call drops) | ✅ **DEPLOYED + container-verified** at branch tip `4e13522f`, queue job `0a0c65ab`, 2026-08-20 ~17:17 EDT |

**Telephony was deployed in a measured 0-active-call window** (polled the PBX
until `core show channels count` read 0 — it was 2–9 calls for eight minutes
before a gap opened at 17:15). AMI reconnected, ARI `pbx_reconnect_success`,
`AMI connected — telephony service active`, **0 restarts**.
⚠️ One `cdr-retry-queue: drain error` at boot+30 s (Redis not writable yet) —
**one occurrence, pre-existing, did not recur**.

✅✅ **PROVEN LIVE ON PRODUCTION, not just by test** — the route probed on the
docker network after deploy:

```
A) no sipUsername  → {"cleared":0,"refused":"sip_username_required"}   [200]
B) sipUsername T18_106_1 → {"cleared":0,"message":"No matching active calls found"} [200]
```

⛔⛔ **(A) is the important one: every portal window still running the OLD bundle
sends no `sipUsername`, so it is now refused.** The desk-phone killing stopped
platform-wide the moment telephony restarted — it did NOT wait for anyone to
reload. (B) proves the route still functions for a correctly-scoped caller.

✅ **Either deploy order was safe** — checked, not assumed:
- *portal first* (what happened): old telephony ignores the unknown
  `sipUsername` field and still matched by extension, so the beep was fixed
  immediately and the desk-phone drop was not, until telephony shipped ~3 h later.
- *telephony first*: the old portal sends no `sipUsername` → the route refuses
  everything → the sweep goes dormant, which by itself stops the drops.

⛔ **An already-open portal tab or desktop window keeps the OLD bundle until it
is reloaded** (full close + reopen for the desktop app) — so the BEEP reaches a
given window only after it reloads. The **call-drop fix needs no client reload**,
because it is enforced server-side.

---

## 7b. The update notice — it stopped nagging, and the mini dialer got its own strip

Commit `4e13522f`, portal-only. Izzy, 2026-08-20: *"put a thin, small 'Reload
Connect was updated' banner"* on the mini dialer, because *"sometimes they have
the app closed all the time. All they have open is the mini dialer"* — and
*"I saw in the app that it keeps showing up again and again."*

- ⛔ **THE REPEAT BUG, and it is a one-line omission:** only the **✕** wrote to
  `localStorage`. Clicking **Reload** recorded **nothing**. So if a reload failed
  to land the new bundle for any reason, the next 5-minute poll re-showed the
  notice — forever — with the Reload button visibly not working. The build id is
  now acknowledged **BEFORE** `window.location.reload()` runs, so the notice
  appears **at most once per deploy per profile** whatever the reload does. The
  acknowledgement is also read **during render**, not only in an effect, so an
  already-handled build cannot flash for a frame.
- ✅ **`MiniDialerReloadBar`** — a **28 px** strip ("Connect was updated" +
  Reload + ✕) rendered **inside `.mini-shell`, immediately ABOVE the tab bar**.
  ⛔ **A flex child, never `position: fixed`.** The pop-out is a small fixed-size
  window; a floating bar would sit on top of the dialpad and the call buttons.
  Above the tabs (not below) so the tab bar keeps its place at the window edge.
  The floating card **stands down** in the mini dialer (`if (!update || isMini)
  return null`) so the two surfaces never both appear.
- ✅ **One click reloads every Connect window.** The desktop app runs the mini
  dialer, the full window and the phone engine as separate BrowserWindows.
  Reload writes `cc-portal-reload-broadcast` to `localStorage`; the other windows
  hear the cross-window `storage` event and reload themselves. ⛔ **No desktop
  shell change, so no installer release** — verified the mechanism is already
  relied on in `AuthGate.tsx:80-88` ("the `storage` event crosses windows") and
  by the DND flag in `useSipPhone.ts`.
- ⛔⛔ **A RELOAD TEARS DOWN THE SIP SOFTPHONE, so a window only ever
  auto-reloads itself when IDLE.** A window on a call — including a *proxy*
  window mirroring the phone-engine's call — ignores the broadcast and keeps its
  own notice, so the person finishes the call and reloads when they choose. The
  window where the button was actually pressed is the user's explicit choice and
  is not second-guessed. A window already on the new build ignores the broadcast
  too (`pendingRef.current` is null), so **there is no reload loop**, and a stale
  broadcast key older than 60 s is ignored.
- New **`useOptionalSipPhone()`** in `useSipPhone.ts` — the notice is chrome and
  must never crash the app over a missing provider. ⛔ Use `useSipPhone` for
  anything that genuinely needs the phone; a silent null there hides a wiring bug.
- Both surfaces share **one `usePortalUpdate()` hook**, so there is still exactly
  one `/version` poller per window.
- **Tests: 8** in `apps/portal/lib/portalReloadNotice.test.ts`, ⛔ **registered in
  `package.json`** (the portal names every test file). All 7 replayed against
  `HEAD` fail there. Portal typecheck **0**, suite **237/239** (the two
  documented pre-existing failures).
- ⏳ **NOT PROVEN: nobody has seen the strip.** ⛔ And it cannot appear until a
  window has reloaded ONCE into this build — an open window is still running the
  old bundle, so it will show the OLD card for this deploy. The strip is what
  they see from the *next* deploy onward.

---

## 8. NOT PROVEN ⏳

- **Nobody has heard the beep.** It is proven as 17 tests and a clean typecheck,
  not by a human being on a call when a second one arrives.
- **Nobody has seen the mini dialer's reload strip** (§7b).
- **No desk-phone call has been *observed* being saved.** The mechanism is proven
  live (the route now refuses an unscoped request — §7), but no human has been on
  a desk-phone call while someone hung up in the app since the deploy.
- **The acceptance test** (needs two lines, ~3 minutes):
  1. Take a call in the Windows app. Have a second call come in →
     **a short beep every 5 s, no ringtone**, and the call-waiting banner shows.
  2. Let the second caller give up → **the beep stops** (it must not run on).
  3. Answer a call on the **desk phone**, then in the app hang up / decline
     something → **the desk call must survive**. Then, after the telephony
     deploy, confirm:
     ```
     docker logs app-telephony-1 --since <deploy> | grep stale-hangup
     ```
     shows `refused` or nothing, and **zero** new
     `zombie_force_evicted … stale-report` lines naming a `PJSIP/T18_106-…`
     desk channel.
  4. ⛔ **The negative that matters most:** the route must still clear a genuine
     phantom. Hang up an app call and confirm the live-calls list does not keep
     a stale row.

---

## 9. Noticed in passing, NOT fixed

- ⚠️ `MultiCallPanel` is mounted only on the full softphone page
  (`dashboard/voice/phone`). `FloatingDialer.tsx` and `crm/live-call` render
  **no call-waiting UI at all** — they now beep, but the user cannot see who is
  waiting or answer them from there. Product decision.
- ⚠️ Asterisk logs `Endpoint 'T18_106' state subscription failed: Extension
  '8002' does not exist in context 'T18_extension-hints'` every ~2 minutes. A
  desk-phone BLF key points at a hint that does not exist. Cosmetic, unrelated,
  and it predates all of this.
- ⚠️ `apps/telephony` carries **41 pre-existing typecheck errors**, nearly all
  `Timeout`/`unref` DOM-vs-Node lib mismatches. Untouched.
