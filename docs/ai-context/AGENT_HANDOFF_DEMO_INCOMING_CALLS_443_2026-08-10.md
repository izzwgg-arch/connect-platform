# AGENT HANDOFF — "we got voicemail, plus it was ringing, and it wouldn't connect" (2026-08-10)

Loopcom Demo, ext 101. Four inbound calls in 90 seconds, every one of them wrong
in a different way. **One root cause.** Diagnosed end to end from the PBX log,
the client blackbox and the api log; fixed for this tenant by a config change
only. **No deploy, no code change, no PBX write.**

Read this before diagnosing any *"the phone rang but the call never connected"*,
before trusting a ring as evidence that the phone system reached a device, and
before flipping a tenant onto the 443 SIP route.

---

## 1. ⛔ THE RULE THIS EARNED

**A ring notification must not be sent when the call has nowhere to land — and
today nothing checks.**

The ring push and the actual call are two independent systems in Connect. On
every one of these calls the push path was perfect (`expoStatus: ok`, incoming
screen on the phone **76 ms** after the push) while the phone system had **no
contact at all** for that extension and never dialled it. The customer holds a
ringing phone that cannot be answered, and no part of the product notices the
contradiction.

Sister rule from the same family — [[desktop-ring-has-no-off-switch]]: a ring
that only one channel can stop is a ring that gets stuck.

---

## 2. The evidence, in the order that settles it

Times are ET. The PBX (`/var/log/asterisk/full`) is on ET; the database and the
client blackbox are UTC (= ET + 4h); loopcom's nginx log is CEST (= ET + 6h).

**Identity:** tenant `cms8yjvth8ctlo4137738yg0n` "Loopcom Demo", PBX **T102**,
ext **101** (Alex Morgan), DID 347-978-0090, caller 562-209-6644, device an
iPhone 16 Pro Max on iOS 26.6.

### The phone system had nobody to call

```
asterisk -rx "pjsip show endpoint T102_101_1" | grep -E "^ Endpoint|Contact:"
  Endpoint:  T102_101_1/101      Unavailable   0 of inf     ← and still, 13 min later
```

`connect-wake-core` (`extensions__60_custom.conf`) loops once a second on
`CONTACTS_PRIMARY=${PJSIP_DIAL_CONTACTS(T102_101)}` /
`CONTACTS_SECONDARY=${PJSIP_DIAL_CONTACTS(T102_101_1)}`. The log shows both
**empty**, `GotoIf(0?registered)` false, `GRACE_LEFT` counting down — for
**13 seconds** on call 1 and **18 seconds** on call 4. The phone was never
dialled on those calls.

### The app believed the opposite

Its own `WEBRTC_CALL_DEBUG` blackbox at the moment of failure:

```
registrationState : registered      wssConnected     : true
registrationAgeMs : 535197          sipStackHealthy  : true
```

⛔ **A client's own "registered" is an opinion.** The PBX contact list is the
fact. When they disagree, believe the PBX.

### Why the registration keeps dying

`PbxEndpointRegistrationEvent` (field is `endpoint`, ordered by `occurredAt`),
22:46 → 23:08 UTC — **23 events in 22 minutes**:

```
REGISTERED (NonQualified) → UNREACHABLE → UNREGISTERED (Removed) → repeat
contacts: 192.157.84.142:30048 → .148:22326 → .148:12492 → .142:22860 → .145:18936
```

Every contact is `192.157.84.x`. `whois` → **Cologuard, Old Bridge NJ** — the
content-filter family in [[webrtc-filtered-internet-port-8089]]. The AOR is
`qualify_frequency 30` / `qualify_timeout 3`, so Asterisk OPTIONS-pings each
contact every 30 s; the filter never returns it, the contact is marked gone, the
app re-registers on a **new source port**, and round it goes.

---

## 3. What the customer actually experienced, call by call

| Time (ET) | What happened |
|---|---|
| **19:03:49** | Push out in 0.2 s, screen up in 76 ms. PBX searched **13 s**, found nothing, never dialled. Answer tapped at +9 s → backend replied `INVITE_CLAIMED_OK` → app then waited **16.2 s** for an INVITE that was never sent and gave up: `failureReason: "sip_invite_not_received"`, `incomingSessionCount: 0`, `sipAnswer {sent:false, attempted:false}`. **This is "ringing but won't connect."** |
| **19:04:40** | Same empty search for 6 s. On the Dial retry at 19:04:46 the app had just re-registered, so the PBX finally reached it — one second before the caller hung up. |
| **19:04:53** | PBX reached the phone immediately. **DECLINE tapped 19:04:55** → `sub-leave-vm` → `VoiceMail(101@loopcom_demo-voicemail,u)` at 19:04:56. Caller heard the greeting and hung up 3 s later. **This is the voicemail** — and note **no message file was written** (INBOX newest is Aug 2), so "we got voicemail" was the greeting playing, not a message left. |
| **19:05:20** | Empty search again. DECLINE tapped 19:05:24, but the phone had **no SIP call to decline**, so the decline reached nothing and the PBX rang on for the full **18 s**. **This is "I hung up and it was still ringing."** |

⛔ **"Voicemail while it was still ringing" was two different calls overlapping.**
The caller redialled four times in 90 seconds; each new ring started while the
previous one was still finishing. Before believing a single call did two
contradictory things, **line the calls up by `linkedid` first**.

### Two things that made it messier

- **Two live iPhones on one login** — iPhone 16 Pro Max (added that day) and an
  iPhone 13 last seen Aug 9, both `active` with VoIP tokens. Every ring fans out
  to both (`totalRowsFound: 2` in the api's `device-fan-out` log).
- **The desk slot in the dial string has no phone on it.** The dial is
  `PJSIP/T102_101&Local/T102_101_1@connect-mobile-wake-dial/n`; `T102_101` has
  zero contacts, so the app is the only real target and there is no fallback.

### ⏳ Not explained: "we got Unknown"

Every server-side record carries the number — the `CallInvite` row
(`fromNumber: "5622096644"`), the VoIP payload (`callerNumber`), the flight
recorder's `INCOMING_SCREEN_SHOWN`, and the SIP invite itself. The carrier sent
no CNAM (`fromDisplay: null`, recording named `IN-NONE-…`), which is normal for
VoIP.ms, so there is no *name* to show — but the number should have appeared.
`ConnectVoipPushHandler.mm` falls back to `"Unknown"` only when `callerNumber`
arrives empty, which it did not. **Ask which screen said Unknown before hunting.**

---

## 4. The fix applied — four tenants now on the 443 SIP route

Moved **Loopcom Demo** and, on Izzy's instruction, **inii mini**. They join
Gesheft and Displaydex.

⛔ **The flip is THREE fields, not two.** Both known-good tenants read:

```
webrtcRouteViaSbc : true
sipWsUrl          : null                          → resolves to wss://app.connectcomunications.com/sip
sipDomain         : m.connectcomunications.com
```

Both tenants moved had an **IP literal in `sipDomain` as well as in `sipWsUrl`**.
`normalizeSipWsUrlHost()` (`apps/api/src/voiceProvisioningBundle.ts:128`)
self-corrects an IP-literal *sipWsUrl* — `if (!isIpLiteralHost(...)) return raw;`,
so a real hostname is left alone — but **nothing corrects `sipDomain`**. Diff the
whole row against a known-good 443 tenant; never flip just the two obvious flags.

`resolveWebrtcConfig()` reads the tenant row per request, so **no deploy and no
restart** — and there is no cache in front of it.

### Verifying the route

```bash
curl -s -i -N --http1.1 --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Protocol: sip" \
  https://app.connectcomunications.com/sip
# → HTTP/1.1 101 Switching Protocols … Sec-WebSocket-Protocol: sip
```

⛔ **Use `--http1.1`.** nginx now has HTTP/2 on (see the portal-performance
handoff) and a default curl gets **426 Upgrade Required**, which reads exactly
like a broken route. Browsers are fine — they open a separate HTTP/1.1
connection because nginx 1.24 has no Extended CONNECT.

The nginx side already existed and was not touched —
`/etc/nginx/sites-enabled/connectcomms`, `location /sip` proxying to
`https://m.connectcomunications.com:8089/ws`.

### ⛔ inii mini did NOT have this fault

Moved because Izzy asked, not on evidence of a defect. Its numbers are healthy:
**11** registration events in 24 h (the demo did 23 in 22 minutes), primary
contact `75.99.110.162` = **Optimum static business, Hicksville NY** — a real
ISP, not a filter — `Avail` at **34.9 ms**. The only churn is a T-Mobile
`172.56.34.x` leg roaming normally. Live tenant is
`cmsgkl4y95grttd13yqhyf1gd` (PBX **T105**, ext 101 baila,
sales@iniimini.com, 140 calls/7d).

⛔ **A second row answers to that name** — `cmnlgryn10010p9par6m0kd81`
"Iniimini", `pbxRemovedAt: 2026-08-09`, zero calls ever, user never logged in.
It was correctly left alone. **21 of 50 tenant rows carry `pbxRemovedAt`**; a raw
name lookup returns them and no Connect screen does. Always filter
`pbxRemovedAt: null`. They are inert — `apps/api/src/billing/routes.ts:647`
excludes them, so their ACTIVE billable extensions cannot invoice. Permanent
erase is a separate confirmed call (`GET /admin/pbx/removed-tenants`,
`POST /admin/pbx/removed-tenants/:tenantId/erase`), and it never erases a tenant
that has ever completed a payment.

---

## 5. ⏳ What is NOT proven

- **Nobody has made a successful call on the 443 route on either tenant.** The
  route is proven as plumbing (handshake `101` + tenant rows byte-identical to
  Gesheft/Displaydex), not as behaviour.
- ⛔ **Both tenants' phones must sign out and back in.** The app never refreshes
  a cached `sipWsUrl`. That cache is also why the flip is **inert on a live
  session** — nothing broke at the moment of the change; baila's existing
  registration kept working on 8089.
- **The acceptance test is a number, not an opinion:** re-run the registration
  query for `T102_101_1`. Today it churned **23 events in 22 minutes**. If it is
  still cycling REGISTERED → UNREACHABLE → Removed after the phones sign back in,
  443 did not fix it and the next suspect is the filter blocking the media, not
  the signalling.
- The **iPhone 13** is still active on Alex's login and still doubles every ring.
  Left alone deliberately — not asked for.

---

## 6. Still open — the defect the 443 move does not fix

The route change makes this **rarer, not impossible**. The structural faults are
untouched and belong to the product, not the network:

1. **A ring is sent without checking the call can land.** The api fans out
   `INCOMING_CALL_WAKE` / `INCOMING_CALL` with no reference to whether the PBX
   holds a contact for that extension. The wake dialplan already knows —
   `connect-wake-core` computes `WARM` from `PJSIP_DIAL_CONTACTS` at line 10 —
   and that verdict reaches nothing on the Connect side.
2. **A decline with no session behind it is silently dropped.** Call 4 shows a
   `DECLINE` recorded against the invite while the PBX rang on for another 14
   seconds. `CallInvite.status` went `DECLINED` and no one told the PBX.
3. **The wake loop has no floor.** It will spin its full grace period against a
   permanently empty contact list rather than failing over to voicemail early,
   so the caller waits the maximum every time the phone is unreachable.

---

## 7. Query and tooling notes (each cost time here)

- `PbxEndpointRegistrationEvent`: the field is **`endpoint`**, not
  `endpointName`, and it has **no `createdAt`** — order by `occurredAt`.
- **`CallFlightSession.events` is the richest client witness**, better than
  `VoiceDiagEvent` for a ring: it carries `PUSH_RECEIVED_FG`,
  `INCOMING_SCREEN_SHOWN`, `SIP_INVITE_RECEIVED`, `DECLINE_TAPPED` with payloads.
  ⛔ Its JS-side rows report `platform: "ANDROID"` **even on iPhones** — the
  hardcoded-platform bug. Judge platform from `deviceModel`, and note the
  separate `cfs_ios_*` rows (`result: "ios_ring_log"`) are the native seed.
- `docker logs app-api-1 --since <ISO>` did **not** honour the timestamp here —
  it returned events two hours off. Use `--since 40m` and filter on
  `d.time` in the pipe instead.
- SSH works straight from the Bash tool (Git Bash) with the repo keys; the PBX
  was used **read-only** throughout, as the standing guardrail requires.
