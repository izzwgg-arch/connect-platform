# AGENT HANDOFF — filtered internet is the norm; reading registration data correctly (2026-08-03)

Investigation of a single question — *"how did Simon's phone perform yesterday?"* — for
**Luxure Management ext 101** over **2026-08-02**. It ended somewhere else: the dominant
reliability factor for this extension is not the app, the PBX, or the wake-and-wait work.
It is a **content-filtering internet service** sitting in front of the device.

Read this before diagnosing any "my phone didn't ring" / "keeps dropping" report.

---

## 0. The headline

**Filtered/proxied internet is normal across Connect's user base, not an edge case**
(confirmed by Izzy 2026-08-03). Treat a filter as present-until-disproven.

**The one-command test that settles it:** take the device's contact IP out of
`PbxEndpointRegistrationEvent.contactUri` and `whois` it.

| whois says | Meaning | Fix lives |
|---|---|---|
| Datacenter / colo block | Filtering proxy in the path | our side (port 443) + customer's filter provider |
| Residential ISP block | Their actual home line | their ISP |
| Cellular carrier block | Device genuinely on mobile data / moving | nothing to fix |

Do **not** infer "unstable Wi-Fi" or "user is moving around" from a high reconnect count.
Both wrong answers were reached in this session before the whois was run.

### ⛔ EXPIRY DATE ON THIS TEST — added 2026-08-05

**The whois only means anything while the device registers DIRECTLY to the PBX.** As of
2026-08-05 Displaydex is live on the 443 route (`webrtcRouteViaSbc=true, sipWsUrl=null`;
nginx `location /sip` on loopcom proxying to `m.connectcomunications.com:8089/ws`). For
any tenant on that route **every `contactUri` is loopcom `45.14.194.179`** — our own
server — and the whois tells you nothing whatsoever about the customer's network.

**Check the tenant's `webrtcRouteViaSbc` flag before trusting a contact IP.** If it is on,
the customer-side evidence lives in **loopcom nginx logs**, not in `contactUri`. See
`AGENT_HANDOFF_ELI_IOS_443_PASTE_2026-08-05.md`.

This is a good problem: it means the fix landed. But a future agent running the §0 test on
a migrated tenant would conclude "datacenter block → filtering proxy" and be reading our
own load balancer.

---

## 1. Identifiers

| Thing | Value |
|---|---|
| Tenant Luxure Management | `cmnlgryob001cp9pafjjqyc99` (VitalPBX tenant 5) |
| Ext 101 owner — Simon Wertzberger | user `cmnmjhp83007np96hmme5t38q` |
| PJSIP endpoints | `T5_101` (desk, 0 contacts, never used), `T5_101_1` (mobile) |
| Main DID | 8455378318 |
| Simon's **cell** | 8455408234 |
| Active devices (both direct-FCM capable) | `cms4vp9yx2pc5ro12fupzp22d` SM-X828U tablet, `cms4vw8z72r04ro12v73g6dkx` Jelly Star |

---

## 2. What the filter looks like in the data

Over 2026-08-02, `T5_101_1` produced **355 registration events / 129 register sessions /
74.5% uptime**. Source addresses:

```
192.157.90.102   22 sessions      whois -> OrgName: Cologuard
192.157.90.103   22 sessions               NetName: DV-DC-1
192.157.90.181    4 sessions               CIDR:    192.157.80.0/20
192.157.90.233   17 sessions               Old Bridge, NJ — no rDNS on any address
192.157.90.234   23 sessions
192.157.90.235   23 sessions
--------------------------------------------------------------------
50.48.1.204       1 session       whois -> Frontier Communications  (his REAL ISP)
```

**128 of 129 sessions came through the filter**, rotating across six of its addresses.
Exactly one went out directly. 83 of 96 measurable reconnects changed source address —
but always *within the same provider block*. That is a proxy load-balancing, **not** a
device moving between networks.

### Ruling out "the tablet leaves the house"

A device switching Wi-Fi → cellular lands in a **carrier** block (T-Mobile/Verizon) and
stays there for a while. That appears **zero times** in 24 hours. Wherever the tablet is,
it is on the same filtered path all day.

---

## 3. ⛔ How to read reconnect counts — most of them are noise

Raw "129 disconnects" is a misleading number and was reported as alarming before being
broken down. Split it first:

| Bucket | Count | Meaning |
|---|---|---|
| Gap **< 5 s** | **80 / 128** | lease renewal. Invisible to callers. Not a fault. |
| Gap 5–30 s | 15 | marginal |
| Gap **≥ 30 s** | **33** | real — a call arriving here fails |

Session-duration histogram shows a **clean ~840 s (14 min) metronome** on 55 sessions
(`836, 837, 836, 839 …` seconds held, then 1–4 s away, then back). **A fixed interval is a
timer, not weather.** Random network failure does not produce identical 14-minute spacing.

Real unreachable time ≈ **6 h**, but **3.4 h of that was an app update** (see §5), leaving
**~2 h genuinely unreachable across ~30 outages**, arriving in **clusters** —
13:07–14:38, 18:06–18:42, 20:08–20:42, 21:14–21:50, 22:06–23:00 EDT. Clustering points at
the proxy; a physically moving device gives isolated single drops.

---

## 4. The wake-and-wait work is CONFIRMED WORKING — and was not needed on either call

`PLAN_PUSH_AND_WAIT_SIMON.md` Phase 3 went live 2026-07-31. First multi-day evidence:

- Wake push → device ready measured **0.9 s, 2.0 s, 0.2 s** on the day's three ring events.
  The original complaint was **28 s**. That problem is gone.
- **The endpoint was already REGISTERED at the moment of all five calls.** The hold-the-call
  loop never had to rescue anything.
- On the 17:27 call the wake push did do real work: the device reported
  `sipStackHealthy: false, previousRegState: "registering"` and the push forced a SIP stack
  restart that recovered in ~2 s.

**Conclusion: the wake path is no longer the bottleneck for this extension. The transport is.**

---

## 5. What actually happened on 2026-08-02 (times EDT)

Five calls hit the main DID. **Zero answered on the mobile app.**

| Time | From | What the data shows |
|---|---|---|
| 00:00 | 8455408234 (**his own cell**) | **Simon test-calling himself.** Invite lived 5.0 s then canceled. No `UI_SHOWN`, no flight session — no evidence a screen ever appeared. |
| 14:40 | 9297916205 | Reached ext 101 at 14:40:25 after ~16 s in IVR-12. **Rang the full 30 s cycle**, ended 14:40:55, → voicemail. `INCOMING_INVITE` present, **`UI_SHOWN` absent**. Genuine "rang, not answered" — but we cannot prove a screen rendered. |
| 14:59 | 9297916205 | Answered elsewhere, 5 s. |
| 15:23 | 9297916205 | **Outbound — Simon calling them back.** Rang 15:23:49, connected 15:23:54, ended 15:24:35 = **41 s clean call.** ⛔ **Produced no `connectCdr` row at all.** |
| 17:27 | 9295703019 | Two consecutive calls. Second one: invite 17:27:48.331 → **`UI_SHOWN` at 17:27:52.118 (3.75 s late)** → `ANSWER_TAPPED {action: DECLINE}` at 17:27:52.359 — **241 ms after the screen appeared.** |

**Zero voicemails** exist for this tenant across Aug 1–3 despite a call routing to voicemail.

---

## 6. Open items in priority order

1. ~~**Move WSS/TURN to port 443**~~ — **DONE for one tenant on 2026-08-05. Copy it to
   Luxure.** Displaydex now runs on the 443 route: nginx `location /sip` on loopcom proxies
   direct to `https://m.connectcomunications.com:8089/ws`, tenant set
   `webrtcRouteViaSbc=true, sipWsUrl=null`, proven by a raw-REGISTER probe returning 401.
   Filters pass 443 because blocking it breaks the whole web. This is now a
   copy-the-recipe job, not a design job.
   ⛔ **The app never refreshes a cached `sipWsUrl`** — the user must sign out and back in
   after the flip, or nothing changes for them.
   ⛔ Do **not** route at the `sbc-kamailio` container on loopcom `:7443` — it is an
   unfinished experiment that dispatches to a nonexistent docker host and answers
   `503 PBX Unavailable`. Full recipe + backups: `AGENT_HANDOFF_ELI_IOS_443_PASTE_2026-08-05.md`.
2. **The 241 ms decline.** A human cannot read an incoming-call screen and decline it in a
   quarter second. We have shipped an auto-decline bug of exactly this shape on iOS before
   (see memory `ios-background-call-autodecline`). Determine whether Simon declined or the
   app did. Until this is answered, "he declined it" is not a safe statement.
3. **`UI_SHOWN` 3.75 s after `INCOMING_INVITE`**, and entirely absent on the 14:40 call.
   A ring the user is never shown is indistinguishable from a ring ignored.
4. **Outbound calls from the app produce no CDR.** The 15:23 call is proven by the device's
   own flight recorder and appears in no call history under any tenant.
5. **Voicemail ingest** — zero rows Aug 1–3 despite a call reaching voicemail.
6. Customer-side: get the Connect app exempted from Simon's filter. Not engineering work.

---

## 7. ⛔ Guardrail note

Ext 104 (`name: phone`) dials `Local/8455408234@T5_cos-all` — **Simon's cell**. Nothing
routes to it: not the inbound route, not IVR-12 (options 1→101, 2/3→RG 800, 9→RG 801),
not ring group 800 (`103` + `101`), not ring group 801 (`101`). No call-forward or
follow-me keys exist on ext 101.

**Izzy confirmed 2026-08-03 that this is deliberate. Do not "fix" it by adding 104 to a
ring group.** Adding a parallel cell leg is discussed in `PLAN_PUSH_AND_WAIT_SIMON.md`
§Phase 5 and would need a fresh explicit mandate — it is a PBX write.

---

## 8. Reproducing this — exact method

All reads. PBX touched read-only (`database show`, `dialplan show`, `awk` on conf files).

```bash
# loopcom (Connect server) — DB one-liners
ssh -i ~/.ssh/connect2_ed25519 root@45.14.194.179 \
  'docker exec -i -w /app/packages/db app-api-1 node -' < script.js

# pbx — READ-ONLY. never gen-conf.
ssh -i ~/.ssh/connect2_server2_ed25519 root@209.145.60.79 \
  "asterisk -rx 'database show da5327df4a24f3a8/extensions/101'"
```

Tables that carried the answer, in the order they were useful:

| Table | What it gave |
|---|---|
| `PbxEndpointRegistrationEvent` | `contactUri` → **the whois that cracked it**; session/gap histogram |
| `VoiceDiagEvent` | `INCOMING_INVITE` / `UI_SHOWN` / `ANSWER_TAPPED` — the only proof a screen rendered |
| `CallFlightSession` | full per-call device timeline incl. `OUTBOUND_*` stages |
| `CallWakeEvent` | wake→register latency, `sipStackHealthy`, `previousRegState` |
| `CallInvite` | ring window (`createdAt` → `canceledAt`/`declinedAt`) |
| `ConnectCdr` | the call as the PBX filed it (model name is `connectCdr`) |

Schema gotchas hit: `MobileDevice` has `model`/`manufacturer`, **not** `deviceModel`/
`osVersion`. `VoiceDiagEvent` uses `type` (not `kind`) and requires a `sessionId` relation.
`CallFlightSession` uses `result` (not `outcome`) and `startedAt` (not `createdAt`).

---

## 9. Corrections made during this session — don't re-derive them

| First read | Actual |
|---|---|
| "3 h 23 m outage at 08:20 — his worst downtime" | **The app update.** He came back at 11:43 on `1.0.0+20260801-231353`; the gap and the version change line up to the second. |
| "7 different addresses — his network keeps flipping" | **One filtering provider rotating its own pool.** Mechanism was wrong. |
| "129 drops — very unstable" | **80 of 128 are sub-5-second lease renewals.** Real count is ~33. |
| "A 48 s call vanished from history" | It was an **outbound** call, and the gap is that **outbound calls aren't logged** — not a lost inbound call. |
| "Two business calls he didn't answer" | One rang a full cycle unanswered; the other was **declined in 241 ms**, which may not have been him. |
