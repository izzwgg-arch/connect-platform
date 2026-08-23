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

**The fix (NOT DONE — either half alone cures it, both are right):**
1. **Env:** `.env.platform:34` → `PUBLIC_API_URL=https://app.connectcomunications.com/api`
   + worker restart. Safe for every reader — `canonicalApiBase()`,
   `billingEmailLifecycle`, `server.ts:30166` all treat the variable as a full
   API base, and all of them currently read it EMPTY (api container) anyway.
   ⛔ The env file is Izzy's (AGENTS.md rule 10).
2. **Code:** guard the worker's `publicBase` so a value equal to the portal
   origin (no path) gets `/api` appended, with a test — otherwise the same
   mismatch silently returns. This half is deployable without touching env.

⛔ **The rule this earned: when you claim "X never worked", you must have
counted the successes, not just found failures.** A fallback-only query
returns fallbacks whether they are 100% or 4% of traffic. The first version
of this report told Izzy a feature he used weekly had never worked.

⛔ Today's texted links are dead forever; the stored attachments are intact
and working `/api/…` links can be re-minted for anyone who asks.

## 3. "It hangs up right when she answers" + "really broken" — her cellular uplink; every ended call was ended by a HUMAN

**No system-side drop exists in the record.** All 11 calls were examined; the
app's end labels are grounded in code (`jssip.ts:3476`: `user_hangup` is
stamped ONLY inside the app's own hangup path — her finger; `Terminated` = the
call ended from the other side).

| time (UTC) | dir | what happened |
|---|---|---|
| 15:21:52 | in | answered 15:22:06, **she hung up** 15:22:11 (4s, `user_hangup`, grade poor) |
| 15:23:06 | in | **the one real failure**: she tapped Accept 15:23:12 — **8s after her connection had gone Unreachable** (15:23:04). The answer had no live socket; caller → voicemail. Push-driven ring outliving a dead socket — the known platform gap ("the api fans out ring pushes without consulting whether the PBX holds a contact", 2026-08-10 handoff). |
| 15:24:56 | out | 29s, normal |
| 15:25:41 | in | answered in 1.0s, **she hung up** at 3.3s (`user_hangup`, poor; 114 packets received — audio WAS flowing) |
| 15:26:01 | out | 4s — her own quick test call |
| 15:26:03 | in | Izzy called **while she was on that outbound call** → busy path → voicemail after the 10s wake-dial leg. Correct behaviour, not a fault (cause 19). |
| 15:26:35 | out | **the 7-minute "really broken" call with Izzy.** Live-measured on the PBX mid-call: **her uplink lost 1,863 of 4,713 packets = 39%** (35% at another sample), RTT 469–539ms — while EVERY other channel on the PBX read 0% loss / 26–46ms in the same second. |
| 15:33:50 | in | 3s (cause 19) |
| 15:33:56 | out | 5s |
| 15:34:45 | out | **191s and CLEAN — 0% loss, RTT 90ms** — minutes after the 39% call, same phone, same network |
| 16:15:59 | in | third caller (989-220-1145): cold-start answer worked mechanically (pushToAnswer 0ms, answerToJoin 1.55s), **the CALLER hung up** after 5s (`Terminated`) — consistent with hearing her broken uplink and giving up |

**The verdict:** her Verizon cellular link swings between perfect and unusable
within minutes. Her registration flapped **Unreachable/Reachable 3× in 12
minutes** (15:23, 15:28, 15:33 — qualify timeouts). The short "hangs up when
she answers" calls are people (mostly her, once the caller) giving up after
3–5 seconds of bad-or-absent audio. The uplink loss explains BOTH directions
of "can barely hear" — the caller hears her gaps directly, and her own
downlink shares the same radio.

**Ruled out, with evidence — do not re-litigate:**
- **Not the France detour**: tcpdump on the PBX shows her RTP arriving DIRECT
  from her phone IP. Only SIP signalling rides loopcom (443 route); media is
  phone↔PBX. Traceroute reaches Verizon's edge at ~30ms.
- **Not the PBX**: 8+ concurrent channels at 0% loss during her 39% sample.
- **Not TURN**: her app's RCA verdict `TURN_missing → enable_TURN_relay`
  (HIGH confidence) is the KNOWN-FALSE verdict — the app never sends
  `iceHasTurn`, the server defaults it false, and the RCA inherits the lie
  (documented 2026-08-05). Our only relay is in France; forcing it would make
  her worse.
- **Not the app build**: build 52 carries all the decline/CallKit fixes; the
  cold-start answer at 16:16 worked in 1.55s.

**⛔ The PCMU nuance (asked and answered):** her inbound calls run PCMU
because only THREE endpoints platform-wide carry the opus-first inbound
override (`T5_101_1` Luxure, `T7_102_1` Create A Box, `T25_101_1` Relax Tires
— the July HD pilot). Everyone else, every iPhone included, gets PCMU inbound
by default. PCMU is an **amplifier, not a cause**: Trust Bookkeepings runs
454 calls on PCMU at ~2% loss with essentially zero complaints. On a clean
line it's invisible; on a 39%-loss line it turns bad into unusable (no loss
concealment; opus on this PBX has FEC). ⛔ **Landau Home HAD the override and
LOST it** — 36 inbound opus calls then 32 PCMU, and the override is gone from
their conf: a panel Apply regenerates the file and silently wipes it. Any
rollout needs re-checking after every panel change (recipe:
`pbx-inbound-hd-recipe` memory / AGENT_HANDOFF_MOBILE_AUDIO_2026-07-30.md).

## 4. What prevention looks like (decisions are Izzy's)

1. **MMS**: the env fix + worker restart and/or the code guard + test (§2).
   Cheap, restores a feature that worked until 2026-08-19.
2. **Her audio**: one call on Wi-Fi decides it. Clean → it's her cellular
   signal and no code fixes it (the long-term answer is the signal, or the
   approved US media server move shrinking every latency budget). Still bad →
   the opus-first override on `T141_101_1` (PBX write, needs a mandate,
   fragile per the Landau precedent).
3. **Answer-with-no-socket** (the 15:23 failure): the standing open item —
   ring pushes don't consult PBX contact liveness even though
   `connect-wake-core` already computes the WARM verdict; and the app accepts
   an answer tap while unregistered instead of showing "reconnecting". A real
   build, not a config flip.
4. **iOS telemetry lies** (found in passing, again): every iOS quality report
   uploads `platform: "ANDROID"`, `networkType: null` — the fix has been in
   the repo since 2026-08-06 (`apps/mobile/src/sip/jssip.ts`) and needs a
   TestFlight build to ship. It makes every iOS diagnosis slower.

## 5. Honest gaps

- ⏳ Nobody has run the Wi-Fi control call — that is the acceptance test for §3.
- ⏳ The MMS fix is not applied; pictures-by-text still fail for everyone
  until the env line or the worker chain is corrected.
- ⏳ Her E911 gap and the duplicate-voicemail-email gap from the build handoff
  remain open and unrelated to today.
- The 39% figure is one sampled interval mid-call (cumulative counters read
  live); the direction (her→PBX) and the same-second 0% on all other channels
  are what make it conclusive, not the exact percentage.
