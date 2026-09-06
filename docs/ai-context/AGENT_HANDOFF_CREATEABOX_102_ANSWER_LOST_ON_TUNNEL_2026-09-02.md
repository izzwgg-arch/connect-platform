# AGENT HANDOFF — Create A Box ext 102: "it answers, but no audio on either side" is the app's 200 OK never reaching the PBX through the office tunnel (2026-09-02)

**Read-only investigation. No code change, no deploy, no PBX write, no data change,
no tenant row touched, no customer contacted.** Everything below was measured live
between 17:10Z and 17:45Z on 2026-09-02. Izzy: *"Create a Box 102 is claiming again
that he cannot answer calls. It answers, but no audio on each side, so I'm guessing
it's not connecting."*

He is right that it is not connecting. The phone shows a connected call; the PBX
never received an answer at all.

Tenant `cmnlgryox001ip9paov24bmr0` (Create A Box, PBX **T7**), ext **102 Sender
Weiss**, user `senderweiss@gmail.com` (`cmnmjhqdt008xp96h8lvo3q1m`), device
`cmsgbqocr0hbrtd136dxshbsf` (Samsung SM-S908U, Android 16), app build
**`1.0.0+20260823-175041`** — the FIXED build, since 2026-08-31 00:31Z.

---

## 1. The headline

Three app answers this week, three identical failures, all through the office
WireGuard tunnel:

| tap (UTC) | invite | path (contact host) | what the app did | what the PBX saw |
|---|---|---|---|---|
| 09-01 18:41:46 | `cmtj0k8sw…` | tunnel `45.14.194.179` | sent 200 OK, no ACK, gave up at 16.2 s | (log gone — today only) |
| 09-01 19:37:43 | `cmtj2k8eq…` | tunnel | sent 200 OK, no ACK, gave up at 16.3 s | (log gone) |
| 09-02 16:39:55 | `cmtkbnfuo…` | tunnel | sent 200 OK, no ACK, gave up at 16.1 s | rang 22 s, caller hung up, **no answer ever logged** |
| 09-02 16:53:34 | `cmtkc4zu7…` | tunnel | sent 200 OK, no ACK, gave up at 16.1 s | rang 30 s, **"Nobody picked up in 30000 ms"**, voicemail |

The two calls from other paths on the same build **worked**, with real audio:

| tap (UTC) | path | result |
|---|---|---|
| 08-31 19:38 | `172.59.212.134` = the office box's own WAN, tunnel DOWN | 76 s, 3,471 packets received, opus, srflx |
| 09-01 14:18 | `69.123.169.102` = Optimum Online (another location) | 226 s, PBX rtpStats: opus, 11,236 rx / 11,470 tx, 0% loss |

**On the fixed build: tunnel 0 of 4, anywhere else 2 of 2.** The 08-24 19:52 call
(broken build, but the same tunnel path) also died in WAITING_FOR_ACK after 8.5 s —
a fifth tunnel loss, distinct from the 500 ms warm-answer regression the other
broken-build calls show.

## 2. The blackbox, line by line (09-02 16:53 call)

`WEBRTC_CALL_DEBUG`, `debugKind: WEBRTC_INBOUND_ANSWER_FAIL`:

- `sipAnswer: {attempted: true, sent: true, confirmed: false}` — the 200 OK was
  built and written to the socket; the ACK never came.
- candidate `status: 6` = JsSIP `STATUS_WAITING_FOR_ACK`. `hasAnswer: true`.
- `answerAttempts: 1`, `pollIterations: 336`, `durationUntilFailureMs: 16087`.
- `registration: {wssConnected: true, sipStackHealthy: true, registrationState:
  registered}` — the socket looked perfectly healthy from the phone's side.
- `failureReason: session_not_found_timeout` — ⛔ **the documented lie**
  (2026-08-06 handoff): the session WAS found (`incomingSessionCount: 1`,
  `answerableSessionCount: 1`). Read the snapshot, never the label.
- `pushToAnswerMs: 88`, `answerPath: deep_link` — push, ring screen and tap were
  instant. The answer pipeline started 84 ms after the tap.

PBX side (`/var/log/asterisk/full`, call `C-0000d92b`, times ET):

```
12:53:28 Called PJSIP/T7_102/sip:T7_102@45.14.194.179:1107;x-ast-orig-host=10.88.0.2:1107   (desk phone, via tunnel)
12:53:28 Called PJSIP/T7_102_1/sip:1eopav19@45.14.194.179:53738;transport=ws              (app, via tunnel)
12:53:29 PJSIP/T7_102_1-00007a99 is ringing          <- the phone's 180 DID arrive
12:53:49 Contact T7_102_1/... is now Unreachable  RTT: 0.000   <- qualify unanswered
12:53:58 Nobody picked up in 30000 ms  -> sub-vm -> voicemail
12:54:16 Removed contact ... from AOR 'T7_102_1' due to shutdown   <- the WS died
```

No `answered` line, no `WARNING`/`ERROR`, nothing about ICE/DTLS/RTP for either
call. **The 200 OK never arrived at Asterisk.** The 16:40 call is the same shape
(`C-0000d90e`: ringing 12:39:51, Unreachable 12:40:04, caller hung up 12:40:12).

## 3. Why the phone SAYS it answered

`apps/mobile/src/sip/jssip.ts:1696` — `session.on("accepted", …)` sets the session
state to `"connected"` and emits `onCallState("connected")`. JsSIP fires `accepted`
when the 200 OK is **sent**, not when it is ACKed (`confirmed`, line 1706). So the
call screen, the timer and the `CALL_CONNECTED` diag event all appear the instant
the answer leaves the socket — while the PBX still has the phone ringing. "It
answers, no audio on either side, for about 15 seconds, then it drops" is exactly
that: the app tears the call down itself at the 16 s answer deadline
(`rejectIncomingInvite` + `hangup`), which is why the caller then hears voicemail.

⛔ **This is NOT the 2026-08-23 warm-answer regression.** That fingerprint is
`answerAttempts: 1, durationUntilFailureMs ≈ 632–750, status 5`, and he did show it
on the broken build (08-24 16:13 → 632 ms, 08-26 14:49 → 750 ms, 08-26 15:15 →
730 ms). The fixed build gives the answer its full 16 s and still never gets an ACK.
Do not tell him to update the app; he has the current one.

## 4. The network he is on, and why it matters

- The office (Create A Box) is behind a **GL.iNet GL-AXT1800** whose WAN is
  **T-Mobile** (`172.59.212.134`, `whois` → `TMO9 T-Mobile USA`). The box is
  WireGuard peer **`10.88.0.2`** on loopcom (`wg show`: endpoint
  `172.59.212.134:4591`, handshake fresh). Its client config is a **split tunnel**
  (`AllowedIPs = 209.145.60.79/32`) — only PBX-bound traffic rides the tunnel;
  everything else (incl. the phone's HTTPS to loopcom) goes straight out the WAN.
  That is why nginx sees his API calls from `172.59.212.134` while the PBX sees
  his SIP contact as `45.14.194.179` (loopcom's MASQUERADE) — same phone, same
  minute.
- His desk phone `PJSIP/T7_102` registers the same way
  (`45.14.194.179:1107;x-ast-orig-host=10.88.0.2`) and **works all day** through
  the tunnel — five answered desk calls today with clean rtpStats (~0.3 s RTT).
- The tunnel is the path with the registration churn: **313 UNREACHABLE / 330
  REGISTERED events on `T7_102_1` in 48 h**, a new contact every 6–12 minutes,
  every one at `45.14.194.179` since 15:35Z today.
- The contact host flips between `45.14.194.179` (tunnel up) and `172.59.212.134`
  (the box's WAN, tunnel down) across the day — the 7-day census shows both every
  day. When the GL's WireGuard link is down the phone's SIP goes direct, and
  **that is the only office path on which an app answer has ever succeeded**
  (08-31 19:38).

## 5. What is proven vs what is inferred

**Proven:**
- The app is on the fixed build and answers in ~250 ms.
- On every tunnel-path answer, the 200 OK is sent, never ACKed, and never seen by
  Asterisk; the app's WebSocket dies 10–30 s later (Unreachable, then "removed due
  to shutdown"). Small SIP messages on that same socket (REGISTER, the 180
  Ringing, OPTIONS replies) get through until the moment of the answer.
- Off the tunnel the same phone, same build, same office box answers with audio.
- Fleet-wide over 7 days: 117 good app answers vs 3 lost on every other tenant;
  Create A Box is **1 good / 3 lost**. This is his site, not the platform.
- The app's `respondInvite` claim lands on the api ~20–25 s after the tap on the
  failing calls — but the `answer-status` GET fired at tap time lands instantly, so
  that lag is the app's own sequencing (it claims after the answer settles), **not**
  a network symptom. Do not chase it.
- From a 10-minute capture on loopcom's `wg0`: the phone's TCP SYN to the PBX's
  8089 through the tunnel advertises **MSS 1340** (the GL box clamps it); the PBX
  answers MSS 1460. Three retransmitted segments from the office in 10 minutes,
  one of them only 529 bytes — the tunnel path also drops ordinary packets now and
  then (T-Mobile, the 8% loss recorded on 2026-08-17).

**Inferred, NOT proven — the leading hypothesis:** the 200 OK is the one LARGE
uplink packet the app ever sends (SIP headers + a WebRTC SDP with ICE candidates and
a DTLS fingerprint, ~1.4–1.6 KB → a full 1340-byte TCP segment → 1380-byte inner
packet → **1440-byte WireGuard packet on the T-Mobile uplink**), and the tunnel path
blackholes packets of that size while passing everything smaller. WireGuard sets DF
on its outer packets and does not do PMTU discovery, so once the carrier drops a
1440-byte UDP packet the same segment is retransmitted at the same size until the
phone gives up — the 16 seconds of "connected, no audio". The direct path recovers
from the same drop because plain TCP honours the carrier's ICMP. It fits every
observation (desk phones' SIP/RTP are all < 1200 bytes; REGISTER/180/OPTIONS are
small; the PBX→phone INVITE rides the downlink, which is not the constrained
direction), but **no packet of that size was seen in either direction in a 10-minute
capture, and the GL box answers no probe on its tunnel address** (ping, 22, 80, 83,
443, 8080 all silent), so the tunnel's usable MTU could not be measured from here.
Section 9 records the second capture's verdict.

## 6. What it is NOT (checked)

- Not the broken APK (§3).
- Not push/wake: `INCOMING_CALL_WAKE` delivered `fcm_direct_ok`, push→tap 88 ms.
- Not the `answered_elsewhere` cancel race: the api logged the 16:53 invite as
  "claimed-but-unconnected invite lost" only at the caller's hangup (16:54:08Z),
  long after the app had given up; no cancel push preceded the failure.
- Not the desk phone winning the race: no `answered` line on either call.
- Not ICE/TURN/media: the call never reached a media negotiation — the answer
  itself was lost. (`iceHasTurn: false`, `turnRequiredForMobile: false`, no
  `iceServers` on the tenant — true, but irrelevant to these two calls.)
- Not the 08-06 "dead-but-healthy socket" as a PHONE fault: the socket was alive
  enough to carry the 180 six seconds earlier.
- Not the tenant's SIP route: `webrtcRouteViaSbc: false`, `sipWsUrl:
  wss://m.connectcomunications.com:8089/ws` — direct to the PBX, as it has been.

## 7. Options, with blast radius traced (nothing done)

**A. Take the app's SIP off the tunnel: move Create A Box to the 443 route.**
Three fields on the tenant row (`webrtcRouteViaSbc: true`, `sipWsUrl: null`,
`sipDomain` already correct), read live per request by `resolveWebrtcConfig`
(`server.ts:773`) — no deploy. The app then opens `wss://sip.loopcom.net/sip`
(the global `SIP_PUBLIC_WS_URL`), which is NOT in the GL box's `AllowedIPs`, so the
signalling goes phone → GL WAN → loopcom nginx → PBX:8089 — the exact path his
HTTPS already uses all day and the path that carried 3 KB blackbox uploads today.
Blast radius: every Create A Box app user (not desk phones) at their **next
sign-out/sign-in**; the same shape Gesheft, Displaydex, Loopcom Demo, inii mini and
B Visible run on. RTP to `209.145.60.79` would still ride the tunnel (UDP, 214-byte
packets — the desk phones prove that works). ⛔ Requires him to sign out and back
in; the app never refreshes a cached `sipWsUrl`. **Recommended first step: cheapest,
reversible, and it removes the tunnel from the one message that is being lost.**

**B. Clamp the tunnel's TCP segment size on loopcom** (our box, no PBX write):
`iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS
--set-mss 1240` and the mirror `-i wg0`. Only TCP traversing `wg0` is affected —
three peers, all PBX-bound; desk phones are UDP and untouched. Fixes the symptom
only if the MTU hypothesis is right, which is why it comes after the proof in C.

**C. Prove it with one test call while capturing** (needs Izzy — it rings the
customer): on loopcom, `tcpdump -ni wg0 -w /root/cab102-cap/call.pcap "host
10.88.0.2"` plus `tcpdump -ni eth0 -w /root/cab102-cap/call-outer.pcap "udp port
51820 and host 172.59.212.134"`, then call (845) 782-6722 → 1, have Sender answer on
the app. The capture will show the 200 OK's segment size, whether it is
retransmitted unchanged, and whether any 1440-byte outer packet ever reaches
loopcom. Five minutes, no config change.

**D. Fix the GL box itself** (Izzy's router, in its UI): WireGuard client MTU
1280 and MSS clamping on the WireGuard zone. Fixes it for anything through the
tunnel, but needs someone in the GL admin panel.

## 8. Query notes that cost a round trip

- `MobileDevice` has no `standingRegistration` column — it lives inside
  `featureFlags` JSON. `CallInvite.extension` is a relation, not a string.
- `VoiceDiagEvent.type` is an enum; an `in:` list with one wrong name throws.
- `Tenant` has no `timezone` column.
- The 09-01 18:41 `CALL_QUALITY_REPORT` carries byte-identical RTP stats to the
  14:18 call (10998 rx / 220 lost / 35 ms) on a 15-second failed call — the app
  reports the LAST call's stats when the failed one produced none. Never read a
  quality report's packet counts without checking they differ from the previous
  call's.
- The GL box answers nothing on `10.88.0.2` (no ping, no TCP) — tunnel MTU cannot
  be probed from loopcom.
- PBX log window is today only; yesterday's two lost calls are proven from the
  blackboxes and the CallInvite loss marker (`ACCEPTED` + `endedAt`, written only
  by the "claimed-but-unconnected invite lost" sweep since `f17f507a`, 2026-08-25 —
  rows older than that carry no marker and read as `ACCEPTED_OK` falsely).

## 9. Second capture (17:35Z–17:43Z) — verdict: inconclusive, hypothesis stands

Eight more minutes on loopcom's `eth0`: the office box's WireGuard flow carried
**3,106 downlink packets with a maximum of 1,452 bytes** (so loopcom → office
does send 1,450-byte tunnel packets) and **3,169 uplink packets with a maximum of
928 bytes**. Across both captures — 18 minutes in total — **no uplink WireGuard
packet larger than 1,024 bytes was ever seen**. That is consistent with the
hypothesis (nothing in the office sends a large uplink packet except the app's
answer) and cannot confirm it (no answer happened in the window). His direct HTTPS
path to loopcom was idle in the window (2 packets), so the direct-path segment
sizes are unmeasured too. The only thing that settles it is option C in §7.

Pcaps kept for that comparison: `/root/cab102-cap/{inner,outer,outer2,direct443}.pcap`
on loopcom (read-only captures, ~4 MB total; delete when done).

## 10. Option A APPLIED — 2026-09-06 15:34Z (Izzy's call)

Izzy, 2026-09-06, on reading §7: *"the app doesn't need the tunnel at all since it works
on 5G — the tunnel is only for the hard phone."* That is the whole cause restated: the
GL.iNet's split tunnel (`AllowedIPs 209.145.60.79/32`) applies to **every device on the
office network**, and the app registered directly to that IP (`sipWsUrl
wss://m.connectcomunications.com:8089/ws`), so on office WiFi it was tunnelled exactly
like a desk phone. On 5G the router is not in the path.

**Done (one guarded DB write, no deploy, no PBX write):**

| Field | Before | After |
|---|---|---|
| `webrtcRouteViaSbc` | `false` | `true` |
| `sipWsUrl` | `wss://m.connectcomunications.com:8089/ws` | `null` |
| `sipDomain` | `m.connectcomunications.com` | unchanged |

`updateMany` guarded on all three prior values → `count: 1`, read back. Backup of the
prior row: `loopcom:/root/cab102-tenant-backup-20260906T153403Z.json`. Reversal is
those two values back.

**What the app is handed now:** `resolveWebrtcConfig` → explicit `sipWsUrl` (null) →
`webrtcRouteViaSbc` true → the global `SIP_PUBLIC_WS_URL` = `wss://sip.loopcom.net/sip`
(read live from `app-api-1`). That is loopcom's hostname, not the PBX IP, so the router's
tunnel rule cannot match it; nginx `location /sip` on `sip.loopcom.net` proxies to
`m.connectcomunications.com:8089/ws`. RTP still goes phone ↔ PBX and will ride the tunnel
on office WiFi like the desk phones' RTP does (small packets — proven fine all day).

**Proof the host works (not inferred):** `/sip` answers `101` on `sip.loopcom.net`,
`sip.connectcomunications.com` and `app.connectcomunications.com`; loopcom held **7**
established nginx→PBX:8089 upstream sockets at flip time; and **Hanna (T141)** — same
`sipWsUrl: null` shape, built after the 08-17 global flip, no tunnel anywhere — has **9
REGISTERED events this week** through `45.14.194.179`, i.e. through `sip.loopcom.net`.
Other null-`sipWsUrl` tenants on the route today: Fixup Group, TYH Industries, Loopcom
Demo 2, YS Plumbing.

**How to tell the tunnel path from the 443 path** (both present `45.14.194.179` to the
PBX, and both carry a `.invalid` `x-ast-orig-host` for an app client): take the contact's
PORT from `pjsip show aor T7_102_1` and look for it in
`ss -tn state established '( dport = :8089 )'` on loopcom. A hit = nginx upstream socket
= 443 route. No hit = MASQUERADE'd tunnel traffic. At 15:37Z Sender's live contact was
`45.14.194.179:48492` **Avail 504 ms** and 48492 was NOT an nginx socket → still the
tunnel, because he has not signed out/in (the app never refreshes a cached `sipWsUrl`).
His other contact `172.56.161.198:35171` (T-Mobile direct, Unavail) is a stale 5G session.

**NOT PROVEN:** no answered call on the new route yet. Acceptance: Sender signs out and
back in on office WiFi → his new contact port shows up in the `ss` list → one inbound call
answered on the app with two-way audio. Negative that matters: the desk phone `T7_102`
keeps registering through the tunnel (it is not WebRTC; untouched).

**Interim workaround** (no change needed): WiFi off on the phone in the office, stay on
5G — the four failures were all on office WiFi, both successes off it.

**Deliberately NOT done:** MSS clamp on `wg0` (§7 B) and the GL box MTU (§7 D) — with
the app off the tunnel there is nothing large left riding it; the capture-backed test
call (§7 C) is now optional. The 504 ms RTT on the tunnel contact and the 313
UNREACHABLE/48 h churn are the office uplink's own problem and remain.
