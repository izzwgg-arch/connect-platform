# AGENT HANDOFF — Hanna's first day of calls: three complaints, three unrelated causes — and an Aug 19 refactor broke every picture-by-text, surfacing today (2026-08-21)

Izzy, 2026-08-21, while on a live call with her: *"she answers the call and
hangs up right when she answers"*, *"she comes in really broken. She can barely
hear me. I can barely hear her"*, *"my phone number comes up as Weber"*, *"she
just sent me a picture by text, and I got it as a link"*, and *"all of this was
working fine already. I need a full report."*

**Read-only investigation — no code change, no deploy, no PBX write, no env
change, no data change.** Everything below was measured live during her test
calls (tcpdump on the PBX, `pjsip show channelstats` on her active call, her
app's own `VoiceDiagEvent` uploads, the Asterisk full log, nginx logs, and the
live DB). Tenant background: `AGENT_HANDOFF_HANNA_FREE_TENANT_2026-08-20.md`.

## 0. The context that frames everything: there is no "was working before"

The tenant was built 2026-08-20. Her only session that day made **zero calls**
(one outbound text "Testing"). The **first eleven calls this account has ever
carried are today's test calls** — so nothing regressed for her; today was the
first exercise. The picture-by-text failure is older than her tenant (§2).

Her setup, verified: iPhone (iOS 26.6), **TestFlight build 52** (has all the
2026-08-02 CallKit/decline fixes), on **Verizon cellular**
(174.197.234.189, Verizon Wireless CGNAT), registered through the 443 route
(nginx `/sip` on loopcom → PBX). Endpoints `T141_101`/`T141_101_1` load and
register correctly.

## 1. "My number comes up as Weber" — her iPhone's own contacts, not us

- The invite rows carry **`fromDisplay: null`** — Connect pushes her the bare
  number `5622096644` with **no name**.
- The PBX sets `CALLERID(all)= "" <5622096644>` — empty name (traced in the
  dialplan for the actual calls).
- Her tenant has **0 Connect contacts**, so nothing of ours could match.
- The app reports the call to CallKit with handle type `"number"`
  (`callkeep.ts showIncomingNativeCall`), and **iOS then matches the handle
  against the phone's own address book** and displays whatever it finds.

So "Weber" is a contact saved on HER iPhone under Izzy's number. Checked
and cleared: `Hanna Weber` does appear in the PBX log, but only as
`EXTENSION_INTERNAL_CID` on a disabled `ExecIf("0?...")` branch and as her own
outbound CID — it does not leak into inbound calls. **Fix: open her iPhone
Contacts and search the number.** Nothing to change in Connect.

## 2. ⛔⛔ "She sent a picture and I got a link" — a REGRESSION shipped 2026-08-19: the identity refactor added `PUBLIC_API_URL` to the worker's URL chain, and that variable is a bare ORIGIN

**⛔ CORRECTION (same day): the first version of this section claimed
pictures-by-text "never worked / broken since May". Izzy pushed back — he had
been using it heavily since May — and he was RIGHT.** The first pass counted
only the FALLBACK messages and never counted the successes. The truth:

- **MMS worked: 40 successful media sends May–July** (8 in May, 21 in June,
  11 in July, last success 2026-07-31 Displaydex). The sparse pre-August
  `invalid_media` failures (Landau ×10 in May, Trust ×1 in June) were a
  different, sporadic cause — and even those degraded gracefully, because
  **the fallback links they texted carried `/api` and WORKED** (verified from
  the stored May/June links).
- **August: 0 successes, 5 failures — ALL on 2026-08-21** (Fixup Group ×4
  17:24–17:50Z, Hanna 15:35Z), and today's fallback links are **dead 404s**.

**The regression, in black and white:**
- Before: the worker's chain was `PUBLIC_API_BASE_URL || API_PUBLIC_URL ||
  PORTAL_PUBLIC_URL || "https://app.connectcomunications.com/api"` — all three
  env names unset in the worker, so the correct literal WITH `/api` was used.
- **Commit `6a0f3a01` (2026-08-19, "one place for the platform's public
  identity") changed it** to `PUBLIC_API_BASE_URL || API_PUBLIC_URL ||
  PUBLIC_API_URL || portalOrigin+"/api"` — adding **`PUBLIC_API_URL`**, which
  has sat in `.env.platform:34` since at least April as the bare origin
  `https://app.connectcomunications.com`, and which **reaches ONLY the worker**
  (the api/api_candidate compose blocks override it to empty via
  `${PUBLIC_API_URL:-}` from the deploy shell; the worker block has no
  override, so env_file supplies it — the CDR_INGEST_SECRET mechanism in
  reverse).
- The worker was deployed with that code **2026-08-19** (`95beef53` ⊇
  `6a0f3a01`). ⛔ **That session verified "changed NOTHING — all six env names
  in that chain are unset in the worker" — but its list of six names did not
  include `PUBLIC_API_URL`, the seventh candidate and the one that IS set.**
  (CLAUDE.md's "worker half shipped hours late" bullet records that check.)
- **Nobody sent a single media message between Jul 31 and Aug 21**, so the
  break was invisible for two days and surfaced today on two tenants at once.

**Mechanism of today's failures, proven end to end:** worker builds
`https://app.connectcomunications.com/chat/a/<id>?e=…&s=…` (no `/api`) →
VoIP.ms fetches the portal's **404 HTML** (4.5 KB text/html) → rejects
`invalid_media` → the fallback texts the customer **that same dead link**.
Curl both ways: without `/api` → 404; with `/api` → **200 image/png 315,646
bytes**. Signatures are valid; only the path root is wrong.

**✅✅ FIXED, DEPLOYED AND CONTAINER-VERIFIED 2026-08-23 (Izzy's explicit
go-ahead in chat, incl. "change them to app.loopcom.net"):**
1. **Env:** `.env.platform:34` is now
   `PUBLIC_API_URL=https://app.loopcom.net/api` (backup
   `.env.platform.bak.20260823T012037Z.mms-api-url`). Verified before relying
   on the hostname: a freshly minted signed link on `app.loopcom.net` serves
   the real image bytes (200, image/png, 315,646 B). Safe for every reader —
   `canonicalApiBase()`, `billingEmailLifecycle`, `server.ts:30166` all treat
   the variable as a full API base, and the api container reads it EMPTY
   anyway (compose override). ⛔ Deliberately scoped: `PUBLIC_PORTAL_URL` —
   the platform-wide loopcom cut-over lever — was NOT touched.
2. **Code (`17b20ab3`):** the derivation lives once in
   `apps/worker/src/smsPublicApiBase.ts` with the guard — a base whose URL has
   no path gets `/api` appended. 10 tests incl. a replay of the exact broken
   production value + a source guard against the inline chain returning;
   worker suite 119/119, typecheck at its 8-error baseline.
3. **Worker DEPLOYED** (`done 82363a5c`, 2026-08-23 01:35Z, after waiting out
   another session's portal-build heavy lock via a log-marker file waiter):
   0 restarts, 0 error-level lines, `resolveSmsPublicApiBase` grepped in the
   container, and the probe run INSIDE it prints
   `resolved publicBase = https://app.loopcom.net/api`.
⏳ **NOT PROVEN: no picture has been sent since the deploy** — the acceptance
test is one picture by text arriving as a real MMS (no link), e.g. re-sending
Hanna's. Watch `voipms_response ok` vs `mms_send_failed` in the worker log.

⛔ **The rule this earned: when you claim "X never worked", you must have
counted the successes, not just found failures.** A fallback-only query
returns fallbacks whether they are 100% or 4% of traffic. The first version
of this report told Izzy a feature he used weekly had never worked.

⛔ Today's texted links are dead forever; the stored attachments are intact
and working `/api/…` links can be re-minted for anyone who asks.

## 3. "It answered — I heard her — then it just hung up" — HER OWN ANSWER's stop-ringing cancel tore down her live call (a race), and the "really broken" audio was her cellular uplink

**⛔ CORRECTION (2026-08-22): the first version of this section attributed the
short calls to "she hung up" off the app's `user_hangup` label. Izzy rejected
that too — "I heard her on the other end, then it just hung up" — and again he
was right.** `user_hangup` is stamped by the app's hangup PATH
(`jssip.ts:3476`), which also runs when CallKit ends the call — it proves the
app tore the call down, not that a finger did.

**The mechanism, established from invite rows + code, with a control case:**

1. She answers instantly from the CallKit lock-screen path (`pushToAnswerMs:
   0` — the buffered cold-start replay); the SIP 200 OK rides the already-open
   socket and the call CONNECTS with audio (Izzy heard her).
2. Her HTTPS **claim** of the `CallInvite` loses the race (or never fires on
   that path) — her cellular link runs 334–664ms RTT with loss — so the
   invite is still **PENDING** when the PBX bridges the call.
3. Telephony's `MobilePushNotifier` sees the answered leg and notifies the api
   **`answered_elsewhere`** ("every still-ringing fork must stop NOW" — built
   for desk-phone answers, 2026-07-29).
4. The api cancels the still-PENDING invite (`server.ts:35153`) and pushes
   `INVITE_CANCELED` to **all of the user's devices — including the phone that
   just answered.**
5. The app's `INVITE_CANCELED` handler (`NotificationsContext.tsx:~5630`)
   matches the lingering invite and calls **`endNativeCall(prev.id)`
   unconditionally — there is no "am I already CONNECTED on this call?"
   guard** — CallKit ends → the endCall handler runs `sip.hangup()` → BYE →
   `user_hangup` stamped, and the screen shows "Call ended".

**The evidence table (all times UTC 2026-08-21):**

| call | claim (`acceptedAt`) | SIP answer | invite `canceledAt` | outcome |
|---|---|---|---|---|
| 15:21:52 | 15:22:06.152 ✓ | 15:22:07.256 | **15:22:07.256** (read-then-write race beat the claim) | died **+3.8s** after cancel |
| 15:23:06 | ✓ claimed | never joined (socket dead 8s earlier) | none | voicemail — the separate ring-push-with-no-socket failure |
| 15:25:41 | **null — never claimed** | 15:25:47.7 | **15:25:48.120** | died **+3.0s** after cancel |
| 16:15:59 | 16:16:07.846 ✓ **before** the answer processed | 16:16:09.1 | **none** | **SURVIVED** until the remote caller hung up |

The 16:16 call is the control: claim landed first → invite ACCEPTED → the
answered_elsewhere sweep found nothing PENDING → no cancel push → the call
lived. Cancel push → death 3–4s later; no cancel → survival. ⛔ **Note the
15:22 row: even a claim that LANDED 1.1s early was overridden** — the cancel
path `findMany({status:"PENDING"})` + unconditional `update` is a
read-then-write race, so the server-side fix must be a conditional
`updateMany({where: {status: "PENDING"}})` at minimum.

**Why this hits Hanna and not the fleet:** it needs (a) a cold-start/lock-screen
answer (her app was freshly launched for nearly every call — new user, day
one), (b) a slow claim vs a fast SIP answer (her lossy cellular), and (c) the
invite still displayed at cancel time. Warm-app users claim first and never
race.

**✅✅ THE SERVER FIX IS BUILT AND DEPLOYED (2026-08-23, commit `61c34205`;
api via deploy-direct, telephony via queue job `1d784a09` in a verified
0-active-calls window; both containers grepped, AMI/ARI reconnected, 0
restarts, tenant map refreshed 29 entries).**
- Telephony: `NormalizedCall.extensionAnsweredChannel` (stamped at all three
  `extensionAnsweredAt` sites + the merge) → `answeredEndpoint` on the
  answered-stop payload (`answeredEndpointFromChannel`).
- api: `mobileRingAnswerPolicy.ts` — an invite whose OWN app device
  (`T<t>_<ext>_<n>`) answered is marked **ACCEPTED with no push**; a desk
  answer (no suffix) still cancel-pushes (the 2026-07-29 feature). The cancel
  write is `updateMany({id, status: "PENDING"})` and a 0-row result (a claim
  landed mid-sweep) **skips the push** — this half protects calls even
  against an old telephony build.
- 14 tests; **all 5 source guards replayed against pre-fix HEAD and fail
  there**. Typechecks at both baselines (api 76, telephony 41).
- ⛔ `deploy-direct.sh` does NOT accept `telephony` (api|portal only —
  refused with "unknown argument"); telephony ships via the deploy QUEUE.
⏳ **NOT PROVEN by a live call** — acceptance: a cold-start lock-screen
answer on a slow link stays up (the api log line to watch:
`mobile-ring-notify: invite fulfilled by its own app — no cancel push`).
**Client layers still pending a TestFlight build:** the `INVITE_CANCELED`
handler re-checking a CONFIRMED session at fire time (the 2026-08-02
deferred-decline rule), and the buffered-replay answer path sending the
claim.

**The audio half is unchanged from the first report:** during the calls that
DID survive, her Verizon uplink measured **39% packet loss / ~500ms RTT
mid-call** while every other PBX channel read 0% in the same second, and was
clean (0%/90ms) minutes later; registration flapped 3× in 12 min. That is what
"she comes in really broken" was, and the Wi-Fi control call is still the
acceptance test.

**Ruled out, with evidence — do not re-litigate:**
- **Not the France detour**: tcpdump on the PBX shows her RTP arriving DIRECT
  from her phone IP; only SIP signalling rides loopcom.
- **Not the PBX**: 8+ concurrent channels at 0% loss during her 39% sample.
- **Not TURN**: the app's `TURN_missing` RCA verdict is the documented false
  positive (`iceHasTurn` is never sent).
- **Not her finger, and not the app build's known bugs**: build 52 carries the
  decline/CallKit fixes; the teardown chain above is a DIFFERENT, unguarded
  path.

**⛔ The PCMU nuance (asked and answered):** her inbound calls run PCMU because
only THREE endpoints platform-wide carry the opus-first inbound override
(`T5_101_1` Luxure, `T7_102_1` Create A Box, `T25_101_1` Relax Tires — the
July HD pilot). PCMU is an **amplifier, not a cause**: Trust Bookkeepings runs
454 calls on PCMU at ~2% loss with essentially zero complaints. ⛔ **Landau
Home HAD the override and LOST it** — a panel Apply regenerates the conf and
silently wipes the baked edit (36 opus inbound calls, then 32 PCMU).

## 4. What prevention looks like (decisions are Izzy's)

1. **MMS**: ✅ DONE 2026-08-23 (§2) — env + guard + worker deploy, verified in
   the container. Awaiting one real picture as the acceptance test.
2. **Her audio**: one call on Wi-Fi decides it. Clean → it's her cellular
   signal and no code fixes it (the long-term answer is the signal, or the
   approved US media server move shrinking every latency budget). Still bad →
   the opus-first override on `T141_101_1` (PBX write, needs a mandate,
   fragile per the Landau precedent).
3. **The self-cancel race (§3)**: the server-side exclusion (don't cancel the
   answering user's own devices) + the conditional-update race fix are
   deployable without an app build and would have saved every one of her
   dropped answers. The client-side guard rides the next TestFlight build.
   Also still open: the 15:23 shape — ring pushes don't consult PBX contact
   liveness, and the app accepts an Answer tap while unregistered.
4. **iOS telemetry lies** (found in passing, again): every iOS quality report
   uploads `platform: "ANDROID"`, `networkType: null` — the fix has been in
   the repo since 2026-08-06 (`apps/mobile/src/sip/jssip.ts`) and needs a
   TestFlight build to ship. It makes every iOS diagnosis slower.

## 4b. Izzy's standing directive (2026-08-23): monitor EVERY call, learn, adapt — the coverage audit

Izzy: *"I want the system to be monitoring every single call on a mobile
device and learn from it: is it on a Wi-Fi network? How was the call? How
many packets… eventually the system would be able to adjust between codecs…
data, data, data."* And: *"Was she on an iPhone? Was she on an Android? Which
codec… always learn and adjust and adapt, always on, especially on the mobile
apps, but even on the WebRTC."*

**What already exists (measured 2026-08-23, last 30 days of
`VoiceDiagEvent type='CALL_QUALITY_REPORT'`):**

| claimed platform | reports | with networkType |
|---|---|---|
| WEB (portal/desktop softphone) | 623 | **623 — complete** |
| "ANDROID" (⛔ includes every iPhone) | 716 | **0** |
| MOBILE | 27 | 0 |

Every call already uploads jitter, loss %, packet counts, codec, duration,
grade and an RCA — mobile AND WebRTC — and **nothing prunes the table**
(53,927 rows back to 2026-04-06, 25 MB). The day-to-day data IS accumulating.

**The blind spots, in priority order:**
1. ⛔ **The mobile fleet lies about the two things Izzy asked for first**:
   `platform` is hardcoded "ANDROID" (every iPhone counted as Android) and
   `networkType` is null on 100% of 743 mobile reports (Wi-Fi vs cellular is
   structurally absent). **Both fixes have sat in the repo since 2026-08-06**
   (`apps/mobile/src/sip/jssip.ts` — platform from `Platform.OS`, networkType
   from WebRTC ICE stats; ⛔ never import netinfo, the undici class) and ship
   only with a mobile build (TestFlight 53 + APK). **This is the single
   gating step of the whole program.**
2. **The app cannot see its own uplink loss** — Hanna's phone reported 1.7%
   while the PBX measured 39% on her uplink. The PBX-side per-call RTP stats
   (both directions) need capturing into `ConnectCdr` at hangup — a
   telephony-side build, the missing half of every call's picture, and the
   half the tuner needs most.
3. **Movement**: derivable without sensors — mid-call IP/candidate changes and
   registration flaps ARE the moving signal (Hanna: 3 flaps in 12 min while
   driving). A derived `networkChangedMidCall` flag on the report is cheap
   once (1) ships.
4. **The tuner** (auto codec/param adjustation) — the decision layer from
   `PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md`, deliberately deferred then for
   lack of labeled data; becomes buildable a few weeks after (1)+(2) land.

⛔ The per-endpooint opus override remains hand-baked and panel-fragile (the
Landau wipe) — the tuner's output must eventually manage it, not humans.

## 4c. ✅✅ THE "DO THEM ALL" NIGHT (2026-08-23, Izzy: "Yep, do them all… the iPhone build will do the last")

Everything below shipped the same night, in order. **iOS/TestFlight build 53
is deliberately HELD — Izzy may change the icon first; it goes LAST.**

1. **Android APK `1.0.0+20260822-221827` BUILT AND PUBLISHED** (142,542,776 B,
   `connectcomms-latest.apk` smoke-tested 200; the size change vs the fleet's
   142,381,803 is the proof it went out). It carries: the 2026-08-06 telemetry
   fixes (real platform label + networkType from ICE stats), and three NEW
   client fixes (`83a5728c`):
   - **Both cancel branches** (iOS VoIP + Expo/FCM `INVITE_CANCELED`) check
     `hasConfirmedSipSession()` + `answerInviteRef` before `endNativeCall` —
     a push can never tear down the call THIS device answered; scoped to the
     answered invite so a second ringing call's cancel still clears its ring.
   - **The warm fast-path claims in the background** (3 retries, idempotent,
     zero answer latency) — the "claim SKIPPED as an optimisation" hole that
     left Hanna's invites PENDING is closed client-side too.
   - **`midCallNetworkEvents` / `networkChangedMidCall`** on every quality
     report — WS drops during a confirmed call, the driving/handoff signal.
   ⛔ The APK was built from the SHARED worktree, which carries another
   session's uncommitted screens reorganisation (`screens/auth/`, `screens/call/`,
   flat files deleted). **Verified safe, not assumed:** the flat screens were
   already deleted before the fleet's 2026-08-21 build succeeded, so the fleet
   APK was NECESSARILY built from the same layout — this publish ships the
   same UI plus the fixes. ⛔ The lesson stands: diff `apps/mobile` against
   HEAD before any fleet build from this tree.
2. **PBX-side per-call RTP stats (`a9008ac1`, api DEPLOYED + migration
   `20260823030000_connect_cdr_rtp_stats` applied and read back;
   telephony queued):** `RtpStatsSampler` polls `pjsip show channelstats`
   over the read-only AMI Command action — active-calls-only (an idle PBX
   gets zero AMI traffic), 10s interval, kill switch
   `RTP_STATS_SAMPLER_DISABLED=1` — keeps the LAST sample per channel (the
   stats die with the channel at hangup, so end-time sampling is structurally
   impossible), and CdrNotifier attaches the samples to the CDR. They land on
   **`ConnectCdr.rtpStats`** beside the app's own report — both directions,
   including the uplink loss no client can measure (Hanna: app said 1.7%,
   PBX said 39%). ⛔ The CLI truncates channel names (~18 chars): matching is
   prefix-based against live calls and an AMBIGUOUS fragment matches NOTHING.
   ⛔ The ingest DECLARES `rtpStats` in zod — an undeclared key is silently
   stripped (the pageSize trap). ⛔ An empty sample set resolves to
   `undefined`, never null — a late leg post must not blank an earlier set.
3. **The tuner is NOT built** — it needs weeks of the above data. That was
   always the plan's order.

⏳ **Acceptance for the night:** one real mobile call after the phone takes
the new APK should upload a quality report with a truthful platform,
networkType, and (if moving) networkChangedMidCall — and its CDR row should
carry `rtpStats`. One picture-by-text should arrive as a real MMS.

## 5. Honest gaps

- ⏳ Nobody has run the Wi-Fi control call — that is the acceptance test for §3.
- ✅ The MMS fix is applied and deployed (2026-08-23); ⏳ no picture has been
  sent through it yet.
- ⏳ Her E911 gap and the duplicate-voicemail-email gap from the build handoff
  remain open and unrelated to today.
- The 39% figure is one sampled interval mid-call (cumulative counters read
  live); the direction (her→PBX) and the same-second 0% on all other channels
  are what make it conclusive, not the exact percentage.
