# PLAN — "Hold the call while the phone wakes up", tested on Simon's extension only

**Status: PROPOSAL. Nothing has been changed on the PBX. Needs Izzy's explicit mandate.**
Written 2026-07-31. Scope: Luxure Management (VitalPBX tenant 5), extension 101, Simon
Wertzberger. No other extension, no other tenant.

---

## 0. The confirmed symptom (owner, 2026-07-31)

Not "the phone never rings." The precise sequence Simon experiences:

1. Call arrives; our wake push is delivered — **the push always arrives**
2. His tablet takes ~28 s to wake and re-register (device self-reported
   `gate=wake_register_slow:28419ms`; PBX-side measurement on 07-30 was 27.2 s)
3. The PBX's 30 s budget expires first and the call is handed to voicemail
4. His phone finishes waking and shows the call; he taps answer
5. The call no longer exists → **connects to nothing, caller shows "unknown", drops**

Every layer of this is measured, from both ends. The fix is to make the PBX wait for the
phone (§3) *and* make the phone wake faster (§5.2).

## 0b. The actual mechanic — corrected 2026-07-31 after tracing the live dialplan

**The 30 s ring timer is a red herring. The call dies in milliseconds, not after 30 s.**

`parse-dial-string` (baseplan ~352) resolves `PJSIP/T5_101_1` via `PJSIP_DIAL_CONTACTS()`
**once**, at the instant of the dial. With no contacts registered it returns empty, the next
line falls back to the raw device string, and `Dial(PJSIP/T5_101_1)` fails immediately with
`cause 3 - No route to destination` → straight to voicemail. The ring timer never starts.

Consequence: **a longer ring timer alone would fix nothing.** The PBX has to *keep asking*,
which is what VitalPBX's own `[send-mobile-push]` loop does and what §3 Edit 1 restores.

### Revised timing budget for Luxure (measured, not assumed)

| Moment | Time |
|---|---|
| Call arrives, wake push fires | **t ≈ 0.4 s** (median across 2,574 calls; 95% within 2 s) |
| Caller in IVR-12 "Main" (10 s response window, 2 s digit) | t ≈ 8–20 s |
| Call reaches ext 101 | t ≈ 10–20 s |
| Tablet finishes waking + registering | **t ≈ 28 s** (device-reported `wake_register_slow:28419ms`) |
| Gap the wait loop must cover | **≈ 8–18 s** |

So a 20 s wait comfortably covers it, and Edit 3 (ring timer 30→75) becomes a **safety
margin rather than a hard requirement** — with the loop consuming ~10–18 s of the 30 s
budget there is still 12–20 s of genuine ringing. Keep Edit 3 anyway for headroom, but it is
no longer the load-bearing change.

Luxure's inbound route (`extensions__50-5-dialplan.conf:490`) goes
`DID 8455378318 → T5_app-ivr,IVR-12` — Simon *does* get the IVR head start. Extensions on a
direct-to-extension DID get none, and will need the full wait.

## 0c. ⚠️ DESIGN FLAW FOUND 2026-07-31 — `DEVICE_STATE` is not trustworthy here

**A stale contact defeats the whole wait loop.** `DEVICE_STATE(PJSIP/T5_101_1)` reports
available whenever *any* contact is bound — alive or not. So on the exact failure this plan
targets (tablet asleep, socket dead, binding not yet expired) the loop would exit on its
first check and dial the corpse, reproducing today's behaviour.

Why Simon accumulates stale contacts — from `pjsip__40-1-profiles.conf` template `[p12-aor]`
plus his AOR:

| Setting | Value | Consequence |
|---|---|---|
| `max_contacts` | 5 (his AOR; Landau's is 3) | 5 slots for 2 real devices — the `remove_existing=yes` eviction never triggers |
| `minimum_expiration` | **600** | a dead binding survives **≥10 minutes** regardless of what the app requests (matches the known "PBX grants 600s despite 120s request") |
| `default_expiration` | 3600 | up to an hour if the client doesn't specify |
| `qualify_frequency` / `qualify_timeout` | 30 / 3 | a died-since-last-ping contact still looks healthy for up to ~33 s |

**Why him specifically:** he is the only user with **two physical devices on one SIP account**
(SM-X828U tablet + Jelly Star, both ext 101 → both bind `T5_101_1`). Every other Android user
has a single device. Two bindings, one of which sleeps for hours, on an AOR with 3 spare slots
and a 10-minute floor.

**Why prior fixes didn't stick:** the stable-`instance_id` work makes a device *replace its
own* binding — correct, but only while its identity is stable. A reinstall mints a fresh
identity, so the old binding becomes an orphan nothing will ever overwrite. Both of Simon's
devices were reinstalled 2026-07-28.

### Required correction to Edit 1

Do **not** gate on `DEVICE_STATE`. Gate on a contact that is actually *Reachable*:

```
 same => n,Set(OK=${PJSIP_AOR(${EXTEN},contact)})        ; contact list for the AOR
 ; then per contact: ${PJSIP_CONTACT(<name>,status)} == "Reachable"
```
Simplest robust form: loop until `PJSIP_DIAL_CONTACTS(${EXTEN})` is non-empty **and** at
least one of its contacts reports `status=Reachable`; treat `Unreachable`/`Unknown` as
"still asleep" and keep waiting. Verify the exact function behaviour on this Asterisk build
before applying — `pjsip show contacts` shows the status column the loop must read.

### The efficient answer to "PBX believes a stale contact" — probe once per call

Both tools exist on this Asterisk build (verified 2026-07-31):
- `pjsip qualify <endpoint>` — "Send a SIP OPTIONS request to all contacts on the endpoint"
- `PJSIP_CONTACT(<name>,status)` — readable from dialplan (since 13.2)

**Design:** at inbound detection (t ≈ 0.4 s — the same moment `MobilePushNotifier.maybePreWake`
already fires) the telephony service also issues an AMI-triggered `pjsip qualify` for the
target mobile endpoint. `qualify_timeout=3` means dead contacts are marked `Unreachable`
within ~3 s. By the time the call reaches the extension (t ≈ 10–20 s behind IVR-12) the
contact table is accurate, and the wait loop — gated on `status=Reachable`, per §0c — keeps
waiting instead of dialling a corpse.

**Why this is the efficient option:**
- One probe per call, not a shortened `qualify_frequency` (which costs battery on every
  device continuously — see the radio-tail argument; rejected).
- No change to `minimum_expiration` (shared template, all tenants, costs battery while
  standing registration remains).
- Collapses the "believing a lie" window from ≤30 s to ~3 s, at the only moment it matters.
- Fires from **our** side (telephony already holds the AMI connection and already detects the
  call at 0.4 s), so no dialplan `System()` shell-out and full logging on our side.

**Classification:** issuing `pjsip qualify` is an active probe, not a config change — but it
is still an outbound action against the read-only PBX and needs the owner's mandate before
it goes live.

**Layered defence — each catches what the previous misses:**
1. **App deregisters on sleep** (REGISTER Expires:0 when backgrounding). Then "no contact"
   honestly means "asleep". Removes stale contacts at source in the orderly case; this is
   the 3CX model and the durable fix. Cannot cover force-stop / crash / network loss.
2. **Probe at call time** (above) — covers exactly those disorderly cases.
3. **`max_contacts` 5→3 + reinstall-stable SIP identity** — stops orphans accumulating.

**Secondary hardening to consider (each is a separate decision):**
- Lower `max_contacts` on his AOR from 5 → **3** (not 2) so `remove_existing=yes` actually
  evicts orphans. Per-extension, low blast radius, no device-side cost.
  **Why not 2:** eviction removes the *oldest* contact with no knowledge of which physical
  phone owns it. At exactly 2 slots for 2 phones, a tablet that re-registers twice under new
  identities can evict the **Jelly Star's live binding**, silently stopping that phone from
  ringing until it next checks in. One spare slot absorbs normal churn.
  **What this does NOT do:** it is not death detection. Eviction fires only when a *new*
  registration needs room. A phone that sleeps and never returns leaves its binding until
  expiry regardless of `max_contacts`.
- Lower `minimum_expiration` so dead bindings die faster. **Shared template — affects every
  tenant. Do not change casually.**
- App side: make the SIP instance identity survive a reinstall, so a reinstall replaces the
  old binding instead of orphaning it. This is the durable fix and it belongs in the APK.

## 1. In plain English

Today our phone system rings a mobile app the same way it rings a desk phone: it looks up
where the phone is, and rings it. If the phone is asleep and hasn't checked in, there is
nothing to ring, so the call goes straight to voicemail. That is the single biggest cause
of "my phone didn't ring."

Every serious VoIP platform solved this the same way: **send a wake-up, then hold the call
for a few seconds while the phone comes back, and only then ring it.** The caller just
hears a couple of extra rings.

**VitalPBX already built exactly this, and the code is sitting on our PBX right now.** It
is currently switched off (details in §2). Their version can't be used as-is because the
push half is locked to their app and their cloud — but the waiting half is ordinary
dialplan we can copy.

And we don't need their push at all: **our server already sends a wake-up push when a call
comes in.** It fired 945 times in the last 24 hours. What's missing is only the waiting.

So the change is small: copy their waiting loop into our own file, and point Simon's
extension — and only Simon's extension — at it.

---

## 2. What we found on the PBX (read-only inspection, 2026-07-31)

### 2a. The mechanism exists

`/etc/asterisk/vitalpbx/extensions__20-baseplan.conf`, line 3047:

```
[send-mobile-push]
exten => s,1,NoOP(Sending push notifications for mobile devices)
 same => n,Set(MAX_TRIES=10)
 same => n,Set(DEVICE_STATUS=${DEVICE_STATE(${TECH}/${DEVICE})})
 same => n,GotoIf($["${DEVICE_STATUS}"!="UNAVAILABLE"]?dial)      ; already up -> dial now
 same => n,System(/usr/share/vitalpbx/scripts/push_notifications ...)
 same => n(loop),GotoIf($[${TRY} > ${MAX_TRIES}]?end)
 same => n,Set(DEVICE_STATUS=${DEVICE_STATE(${TECH}/${DEVICE})})
 same => n,GotoIf($["${DEVICE_STATUS}"!="UNAVAILABLE"]?dial)      ; came back -> dial
 same => n,Wait(2)
 same => n,Set(TRY=$[${TRY}+1])
 same => n,Goto(loop)
 same => n(dial),Dial(${PJSIP_DIAL_CONTACTS(${DEVICE})})
 same => n(end),Hangup()
```

Push once, then poll every 2 s up to 10 times (**~20 s**), dial the instant the device
appears, hang up if it never does.

### 2b. It is currently DEAD CODE

`[parse-dial-string]` (baseplan line 340) is what turns `PJSIP/T5_101_1` into something
dialable. Lines 348–350:

```
 same => n,GotoIf($["${TECHNOLOGY}"="PJSIP"]?:regular)
 same => n,Goto(regular-pjsip)                          ; <-- unconditional
 same => n,Set(PARSED_DEV=Local/${USER}@pjsip-push)     ; <-- never reached
```

The `Goto` on the line above jumps straight past the push branch, so **no call on this PBX
ever goes through the wait loop.** `[pjsip-push]` has no other callers. Every PJSIP device
is dialed directly at its registered contacts; if there are none, the dial fails instantly.

That is exactly Simon's 2026-07-30 failure: `cause 3 - No route to destination` → voicemail,
while the phone finished re-registering 7 s later.

### 2c. Their push sender is unusable for us

`/usr/share/vitalpbx/scripts/push_notifications` is **ionCube-encrypted PHP**. It talks to
VitalPBX's own cloud with VitalPBX Connect's Google/Apple credentials. We cannot read it,
cannot reuse it, and it cannot wake our app. Irrelevant — see §3, we don't need it.

### 2d. Simon's current call path

```
inbound route → Dial(Local/101@T5_ring-group-dial/n, 30, ...)      ; 30 s ring timer
  → T5_ring-group-dial → Gosub(T5_cos-all, 101, 1)
    → baseplan "Dialing Local Extension"
      → DIAL_STRING = DB(da5327df4a24f3a8/extensions/101/dial)
                    = "PJSIP/T5_101&PJSIP/T5_101_1"
      → Gosub(parse-dial-string)   ; PJSIP/X -> PJSIP_DIAL_CONTACTS(X), push branch skipped
      → Dial(...)
```

Live state at time of writing: AOR `T5_101_1` has **0 contacts**; `T5_101` (desk phone) has
had 0 contacts throughout — there is no desk phone on this extension.

**The 30 s ring timer is the budget.** A 20 s wait fits inside it with 10 s left to ring.

---

## 3. The proposed change

Two edits. Both are reversible in one command. Neither touches the baseplan, any other
tenant, or any other extension.

### Edit 1 — add our own waiting context

Appended to `/etc/asterisk/extensions__60_custom.conf` (a file Connect already owns and
which already has a backup history):

```
; Connect: hold an inbound call while a sleeping mobile app wakes and re-registers.
; Modelled on VitalPBX's own [send-mobile-push] (baseplan ~3047), minus their push
; script — our API already sends the wake push at ring time (PBX_INBOUND_PREWAKE).
[connect-mobile-push]
exten => _[-+*#0-9a-zA-Z].,1,NoOp(Connect push-wait for ${EXTEN})
 same => n,Set(MAX_WAIT=20)
 same => n,Set(WAITED=0)
 same => n,Set(DEVICE_STATUS=${DEVICE_STATE(PJSIP/${EXTEN})})
 same => n,GotoIf($["${DEVICE_STATUS}"!="UNAVAILABLE"]?dial)
 same => n,Ringing()                        ; caller hears normal ringback while we wait
 same => n(loop),GotoIf($[${WAITED} >= ${MAX_WAIT}]?end)
 same => n,Wait(1)
 same => n,Set(WAITED=$[${WAITED}+1])
 same => n,Set(DEVICE_STATUS=${DEVICE_STATE(PJSIP/${EXTEN})})
 same => n,NoOp(Connect push-wait ${EXTEN}: ${WAITED}s status=${DEVICE_STATUS})
 same => n,GotoIf($["${DEVICE_STATUS}"="UNAVAILABLE"]?loop)
 same => n(dial),NoOp(Connect push-wait: dialing ${EXTEN} after ${WAITED}s)
 same => n,Set(CONTACTS=${PJSIP_DIAL_CONTACTS(${EXTEN})})
 same => n,GotoIf($["${LEN(${CONTACTS})}"="0"]?end)
 same => n,Dial(${CONTACTS})
 same => n(end),NoOp(Connect push-wait: giving up on ${EXTEN} after ${WAITED}s)
 same => n,Hangup()
```

Differences from VitalPBX's version, and why:
- **1 s polling instead of 2 s** — halves the worst-case delay after the phone is ready.
- **`Ringing()`** — otherwise the caller hears silence while we wait.
- **No push call** — our server already pushes at ring time. Keeps the PBX free of any new
  script, credential, or outbound internet dependency.
- **Empty-contacts guard before `Dial`** — avoids a confusing failure if the device state
  flips but no contact is registered yet.

### Edit 2 — point ONLY ext 101's mobile leg at it

One AstDB key:

```
current: /da5327df4a24f3a8/extensions/101/dial = PJSIP/T5_101&PJSIP/T5_101_1
new:     /da5327df4a24f3a8/extensions/101/dial = PJSIP/T5_101&Local/T5_101_1@connect-mobile-push
```

The desk-phone leg `PJSIP/T5_101` is left exactly as it is. `parse-dial-string` leaves
`Local/...` channels untouched (only `PJSIP/...` is rewritten), so the new leg flows
straight into our context.

### Edit 3 — extend the ring budget for ext 101 (REQUIRED, added 2026-07-31 after owner input)

**Without this the wait accomplishes nothing.** The caller currently gets 30 s total before
voicemail takes over (`/da5327df4a24f3a8/extensions/101/ringtimer = 30`, and the ring-group
path hard-codes `Dial(...,30,...)` then `Goto(sub-extensions-vm,VM-101,1)`). Spending ~28 s
of that waiting leaves ~2 s to ring — the exact failure the owner describes: phone finishes
waking as the call dies, he taps answer, the call is gone, the app shows "unknown".

```
current: /da5327df4a24f3a8/extensions/101/ringtimer = 30
new:     /da5327df4a24f3a8/extensions/101/ringtimer = 75      ; ~30s wake + ~45s ringing
```

**OPEN QUESTION — resolve before applying.** The per-extension `ringtimer` only governs a
call routed *directly* to ext 101. If Simon's DID lands on a ring group (T5 has RG 800 and
RG 801), the timeout comes from `RG_RINGTIME` / the hard-coded `,30,` in
`extensions__50-5-dialplan.conf`, which is a VitalPBX-generated file that regenerates. Find
the inbound route's actual destination first; if it is a ring group, the ring-time change
belongs in the panel's ring-group setting, not in AstDB.

Caller-experience note: 30 s of ringback before the phone even starts ringing is a long hold
and many callers will abandon. This is why the app-side wake fix (§5.2) is not optional —
with it the wait should be ~5 s and the hold becomes invisible. The hold makes it *work*;
the app fix makes it feel *normal*.

### Activation

`asterisk -rx "dialplan reload"` — re-reads dialplan files only. **NOT** `vitalpbx gen-conf`
(that regenerates config and is a hard no on this box). The AstDB change needs no reload.

### Rollback (single command, instant)

```
asterisk -rx 'database put da5327df4a24f3a8/extensions/101 dial "PJSIP/T5_101&PJSIP/T5_101_1"'
asterisk -rx 'database put da5327df4a24f3a8/extensions/101 ringtimer 30'
```

Behaviour returns to exactly today's. The unused context can be left in place or removed
later.

---

## 4. What could go wrong, and the answer to each

| Risk | Assessment |
|---|---|
| Another tenant/extension affected | Impossible by construction — one AstDB key on ext 101, plus a new context nothing else references. Baseplan untouched. |
| Caller hears silence during the wait | `Ringing()` gives normal ringback. Verify by ear on the first test call. |
| Wait outlasts the ring timer | Ring timer is 30 s, wait capped at 20 s, leaving 10 s to actually ring. Do not raise MAX_WAIT above 25. |
| Phone never comes back | Local leg hangs up, outer Dial finishes, call goes to voicemail — **identical to today**. No new failure mode. |
| VitalPBX GUI overwrites the dial key | Likely if anyone edits ext 101 in the panel. It silently reverts to today's behaviour — undoes the test, breaks nothing. Re-check the key after any panel edit. |
| Extra Local leg confuses CDR | Plausible. Our CDR rules dedupe on lastapp+disposition. Verify Simon's call records after the first successful test before rolling this anywhere else. |
| Call retained longer on the PBX | Up to 20 extra seconds of a held channel per sleeping-phone call. Negligible at our volume; would need review before a fleet-wide rollout. |

---

## 4b. Server-side change — wake the whole tenant, not just the target (owner request)

Separate from the PBX work, ships independently, benefits every tenant.

**Today** (`apps/api/src/server.ts` `/internal/mobile-prewake`, ~30916): if the target
extension is already known at first AMI detection, only that extension's owner is woken.
Only when the extension is *not* yet known does it wake every user in the tenant with a
device asleep >45 s (`PBX_PREWAKE_DEVICE_STALE_MS`).

**Requested:** always wake the tenant's asleep devices, target known or not. Rationale: a
call that later transfers, rolls to a colleague, or hits a ring group finds those phones
already awake instead of starting the 28 s clock from scratch.

**Cost:** negligible at current scale — 17 active devices platform-wide, the 45 s staleness
gate and the 12 s per-user cooldown (`PBX_PREWAKE_USER_COOLDOWN_MS`) both still apply, and
FCM messages carry `ttl: "45s"` so nothing backlogs. Re-evaluate before the fleet grows past
a few hundred devices.

**Implementation:** in the `input.toExtension` branch, keep the owner as a priority target
but append the tenant-wide asleep set rather than returning early. `PREWAKE_MAX_USERS` (25)
already caps the fan-out.

**Timing is already right and needs no change** — measured over 3 days / 2,574 calls, the
prewake fires a median **0.4 s** after the call appears, 95% within 2 s. The wake-up has
never been the slow part; the device's 28 s response is.

## 5. This will not work on its own — two dependencies

1. **The tablet has to be reachable at all.** As of 2026-07-31 14:05 UTC a direct-FCM wake
   was delivered to both of Simon's devices and neither acknowledged it in 5 minutes; the
   endpoint has been unregistered since 06:50 UTC. **If the device is off or force-stopped,
   waiting 20 s changes nothing.** The test cannot start until Simon opens the app and we
   confirm a wake is acknowledged.
2. **Wake-to-register must fit in the window.** Measured worst case on 2026-07-30 was
   **27.2 s** — outside a 20 s wait. The fix exists (commit `20ca197b`: a wake register no
   longer queues behind a stuck connect attempt) but is **not in any shipped APK**. Simon's
   tablet needs a build carrying it, or the wait will keep losing the race.

Both of these are prerequisites, not follow-ups.

---

## 6. Test protocol (Simon's extension only)

1. **Prove the device is reachable.** Simon opens the Connect app. Send a manual wake
   (`POST /internal/mobile-prewake`, tenant `cmnlgryob001cp9pafjjqyc99`, ext 101) and
   confirm a `DEVICE_PUSH_RECEIVED` ack. **If no ack, stop — nothing else is testable.**
2. **Baseline.** Background the app, wait for `T5_101_1` to go unregistered, call the DID.
   Expect: straight to voicemail. Record the timing.
3. **Apply** Edit 1 + Edit 2 + `dialplan reload`.
4. **Verify the wiring** without a call: `dialplan show connect-mobile-push` and
   `database get da5327df4a24f3a8/extensions/101 dial`.
5. **Repeat the same call.** Expect: caller hears ringing for roughly 3–20 s, then the
   tablet rings, then a normal answered call with two-way audio.
6. **Watch, in this order:** API log `FCM_DIRECT_DELIVERED` → `DEVICE_REGISTER_COMPLETE`;
   PBX `NoOp(Connect push-wait ...)` lines showing the countdown; `PbxEndpointRegistrationEvent`
   REGISTERED; then the CDR for the call.
7. **Acceptance:** the call connects AND the PBX `pjsip show channelstats` transmit counter
   climbs while Simon talks (per the standing audio rule — "I can hear them" tests only half
   the pipe).
8. **Roll back immediately** on anything unexpected, using the §3 command.

---

## 7. If it works

Then, and only then, in this order:
1. Simon runs on it for several days. Watch his registration history and CDRs.
2. Reduce the keep-alive machinery **on Simon's phone only** and measure battery + ring
   reliability. This is where the battery win lives — the app no longer has to hold itself
   awake around the clock.
3. Roll out one tenant at a time, each with the same before/after evidence.
4. In parallel and independently: finish the Expo→direct-FCM migration (worker has no
   direct sender; 10 of 16 Android devices have no native FCM token) so the wake that
   starts this whole sequence is as fast and reliable as possible.

Parallel ring to a real cell number stays the right answer for any extension whose device
genuinely cannot be relied on to stay powered — that is standard practice at RingCentral,
8x8 and 3CX, not an admission of defeat.

---

# 8. FULL GAME PLAN A–Z (agreed 2026-07-31)

Ordering rule throughout: **anything that changes call or audio behaviour ships alone, with a
supervised two-way test.** Everything else can batch.

## Phase 0 — prerequisites (nothing else is testable without these)

| # | What | Where | Blocker? |
|---|---|---|---|
| 0.1 | Simon opens the Connect app; we send a manual wake and confirm a `DEVICE_PUSH_RECEIVED` ack | owner + us | **YES** — as of 07-31 14:05 UTC his tablet ignored a direct-FCM wake entirely |
| 0.2 | Confirm the wait-loop gating function behaves as documented on this Asterisk build (`PJSIP_CONTACT(...,status)` values) | PBX, read-only | yes, for Edit 1 |

## Phase 1 — server work (our boxes only, no PBX writes, ships independently)

| # | Change | File / service | Risk | Why |
|---|---|---|---|---|
| 1.1 | Wake the **whole tenant's** asleep devices on inbound detection, not just the target extension | `apps/api` `/internal/mobile-prewake` (~30916) | low | owner request; transfers/roll-overs find phones awake. §4b |
| 1.2 | Fire an **on-demand liveness probe** (`pjsip qualify`) at inbound detection, over the AMI link telephony already holds | `apps/telephony` `MobilePushNotifier.maybePreWake` | low, but an active action against the PBX — **needs mandate** | collapses the stale-contact window from ≤30 s to ~3 s. §0c |
| 1.3 | Port **direct FCM into the worker** | `apps/worker/src/main.ts` (no direct sender today) | low | 1,057 pushes/24 h currently 100 % Expo relay |
| 1.4 | Add `active: true` filter to the worker's device query | `apps/worker` ~line 601 | trivial | it currently pushes to deactivated ghost rows |
| 1.5 | Make the **codec a per-device server flag**, defaulting to today's behaviour | `apps/api` featureFlags + mobile | low (no behaviour change on deploy) | lets us A/B G.711 vs Opus by ear without a build |
| 1.6 | Accept and store **answer-attempt** reports | `apps/api` (`DEVICE_ANSWER_TAPPED` stage already exists, never sent) | trivial | today a failed answer is indistinguishable from ignoring the call |

## Phase 2 — new APK (one build, but item 2.3 held back — see note)

| # | Change | Why | Ship with the batch? |
|---|---|---|---|
| 2.1 | **Wake-register abort fix** — a wake register aborts a stuck in-flight connect instead of queueing behind it (already written, commit `20ca197b`, never shipped) | this is the 28 s → ~5 s fix; 24 of those 28 s were queueing behind two dead 12 s connect attempts | **yes — the priority item** |
| 2.2 | **SIP identity survives reinstall** | a reinstall currently mints a new identity, orphaning the old contact so nothing ever replaces it. Both Simon's devices were reinstalled 07-28 | yes |
| 2.3 | **Deregister cleanly when backgrounding** (REGISTER Expires:0) — the 3CX model | makes "no contact" honestly mean "asleep"; kills stale contacts at source | **NO — hold.** Directly contradicts standing registration. Ships alone, after the wait loop is proven, as its own supervised test |
| 2.4 | Report **answer attempts** (fills 1.6) | ends the "did he tap answer or not?" blind spot | yes |
| 2.5 | Report the **real build number** | all 16 Android devices report "1.0.0"; we cannot tell a July build from a May one | yes |
| 2.6 | **Retry the native FCM token report** if the 5 s race returns null | 10 of 16 devices have no token and are stuck on the Expo relay | yes |
| 2.7 | Honour the server **codec flag** from 1.5 | audio A/B without further builds | yes (flag defaults to current behaviour) |

## Phase 3 — APPLIED 2026-07-31 14:06 UTC under explicit owner mandate ("Yes, PBX Go")

### ⚠️ Discovery that changed this phase: the engine already existed

`/etc/asterisk/extensions__60_custom.conf` already contains **`[connect-wake-core]`** — a
complete, well-built wake-and-grace engine: probe contacts → emit a non-blocking
`ConnectWake` AMI UserEvent (consumed by telephony's `ConnectWakeConsumer`) → ringback →
1-second grace loop up to `connect/system/wake_grace_secs` (default 20) → return when
registered. It is canary-gated, default-closed, via AstDB `connect/wake_canary/T<tid>_<ext>`.

**`T5_101` is on that allowlist and has never once used it.** Its only entrypoint is
`[connect-dial-with-wake]`, reached solely from Connect's own tenant-router / IVR contexts
(lines 137/148/185/199). Luxure's DID routes `8455378318 → T5_app-ivr,IVR-12` — VitalPBX's
native IVR — so the call never enters that context. The engine was switched on for Simon
and structurally unreachable.

So Phase 3 became **"bridge the native path into the existing engine"**, not "build a loop".
Nothing was duplicated; `[connect-wake-core]` was not modified.

### What was actually applied

| # | Change | Status |
|---|---|---|
| 3.1 | New context `[connect-mobile-wake-dial]` appended to `extensions__60_custom.conf`. Gosubs `connect-wake-core` for the wake + cold grace, then waits (default 20 s, `connect/system/mobile_reach_wait_secs`) until `DEVICE_STATE(PJSIP/<ep>)` leaves `UNAVAILABLE`, then dials. Backup: `extensions__60_custom.conf.bak.connect-mobile-wake-dial.20260731-140628` (336 lines) | ✅ applied, `dialplan show` confirms |
| 3.2 | AstDB `da5327df4a24f3a8/extensions/101 dial`: `PJSIP/T5_101&PJSIP/T5_101_1` → `PJSIP/T5_101&Local/T5_101_1@connect-mobile-wake-dial/n` | ✅ applied, read back verified |
| 3.5 | `dialplan reload` (never `gen-conf`) | ✅ 1547 contexts, `connect-wake-core` intact, no new errors |
| 3.3 | `max_contacts` 5→3 | ❌ **NOT applied — deliberately.** It lives in `pjsip__50-5-extensions.conf`, a VitalPBX-**generated** file with no AstDB key; an edit there is silently reverted on the next regeneration. Do it via the panel if wanted. The call-time reachability gate covers the stale case anyway |
| 3.4 | `ringtimer` 30→75 | ❌ not applied — §0b showed it is headroom, not load-bearing |

### Gate choice, and what was dropped

Gate is `DEVICE_STATE(PJSIP/<ep>)`, verified live: `NOT_INUSE` for the registered mobile
endpoint, `UNAVAILABLE` for `T5_101` (zero contacts). Same signal VitalPBX's own
`[send-mobile-push]` uses.

The planned per-contact `PJSIP_CONTACT(<id>,status)` walk was **dropped**. `status` does
return exactly `Reachable` (verified), but qualify feeds both that field and the device
state — so it carries no extra information, while putting fragile comma-delimited parsing
in a live call path. The residual "bound but dead, qualify hasn't noticed" window (≤30 s) is
closed by the on-ring `PJSIPQualify` probe in telephony (§0c), which is the right layer.

### Rollback (one command)

```
asterisk -rx 'database put da5327df4a24f3a8/extensions/101 dial "PJSIP/T5_101&PJSIP/T5_101_1"'
```
Takes effect on the next call; no reload needed. The context can stay (inert).

## Phase 3 (original proposal — superseded by the above)

| # | Change | Rollback |
|---|---|---|
| 3.1 | Add `[connect-mobile-push]` waiting context to `/etc/asterisk/extensions__60_custom.conf` — gated on a **Reachable** contact (§0c), 1 s poll, 20 s cap, `Ringing()` for ringback | remove context (inert once 3.2 is reverted) |
| 3.2 | Point ext 101's mobile leg at it: `dial` → `PJSIP/T5_101&Local/T5_101_1@connect-mobile-push` | `database put … dial "PJSIP/T5_101&PJSIP/T5_101_1"` |
| 3.3 | `max_contacts` 5 → **3** on his AOR (not 2 — see §0c) | `database put …` back to 5 |
| 3.4 | *Optional headroom:* `ringtimer` 30 → 75 | `database put … ringtimer 30` |
| 3.5 | `asterisk -rx "dialplan reload"` — **never** `vitalpbx gen-conf` | n/a |

## Phase 4 — prove it, then extend

1. Baseline call → voicemail (record it).
2. Apply Phase 3, verify wiring without a call, then repeat the call.
3. Acceptance: call connects **and** `pjsip show channelstats` transmit counter climbs while he
   talks (per the standing audio rule — "I can hear them" tests half the pipe).
4. Simon runs on it several days; watch registration history and CDRs.
5. **Then** reduce keep-alive on his phone only, and measure battery + reliability. This is
   where the battery win lives.
6. Then tenant-by-tenant rollout, each with before/after evidence.

## Phase 5 — bigger projects (not this week, decide separately)

| Project | Why it matters |
|---|---|
| **US relay server** | loopcom is in Lauterbourg, France; the PBX is in St. Louis. Every relayed call crosses the Atlantic twice. Biggest single audio-quality lever, and the reason Opus sounds worse than G.711 here |
| **Kamailio/RTPengine in front of the PBX** | both containers are already running on loopcom. Our server registers permanently with the PBX (never sleeps, never stale) and owns the wake-and-wait. Signalling-only version works even from France; media relay needs the US box first. Removes this entire class of problem — but it is a build, and it makes our server a single point of failure |
| **Parallel cell ring** for devices that cannot be relied on to stay powered | standard practice at RingCentral/8x8/3CX. Needs owner mandate (PBX write) |
| **Adaptive codec selection** | only after 1.5 + 1.7 give us per-call codec + quality data. A measured rule, not machine learning — 120 answered calls/week is far too little to train anything |

## What we deliberately rejected, and why

| Rejected | Reason |
|---|---|
| Shorten `qualify_frequency` 30 s → 15 s | costs battery on every device continuously; phone radios idle ~10–20 s after any packet, so halving the gap can stop the radio ever powering down. The per-call probe (1.2) gets the same certainty for free |
| Shorten `minimum_expiration` (lease) now | shared template across all tenants incl. desk phones, and costs battery while standing registration remains. Revisit **after** phase 2.3 — once nothing is renewing, it is free |
| `max_contacts` = 2 (exact device count) | eviction removes the *oldest* contact with no idea which phone owns it; the tablet re-registering twice could evict the Jelly Star's live binding |
| Machine learning for audio tuning | no labelled data and ~120 answered calls/week. A rule over the loss/jitter/RTT we already collect captures nearly all of it and is debuggable |
