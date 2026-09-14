# ⛔⛔ AGENT HANDOFF — the support desk blamed a router while the real packet loss was on a DIFFERENT extension, and the proof was already in our own database (2026-08-26) — READ FIRST before accepting ANY call-quality diagnosis, before proposing a NAT/SIP-ALG fix, or before telling a customer their internet is filtered

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TRIMPRO_105_AUDIO_2026-08-26.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**)
Memory: [[rtpstats-is-the-per-call-quality-data]].
Escalation ref **Y6GQZ8**, Shia Weinstock ext 105, Trimpro (PBX tenant 11).

- ⛔⛔ **`ConnectCdr.rtpStats` IS the per-call quality data, and the escalation researcher
  does not know it exists.** Its report said in so many words *"There is no per-call
  quality data tied to extension 105"* — while **14 of that extension's 48 calls carried
  `rtpStats`, including the one that caused the complaint.** It had read only
  `VoiceDiagEvent` (client self-reports, all filed against one user id — hence its honest
  "I cannot prove these rows are Shia's" caveat), found it unattributable, then reasoned
  from **call durations** and blamed the customer's router for SIP ALG / NAT.
  **Query `rtpStats` before accepting any call-quality verdict.** It names the CHANNEL
  (`PJSIP/T11_103-000037f8`), so it attributes loss to one ENDPOINT, not to an account.
- ⛔⛔ **THE PER-ENDPOINT CENSUS IS THE WHOLE DIAGNOSTIC, and here it named a different
  phone.** 7 days: **T11_103 — 49 legs, 7 at ≥5% loss, worst rx 49%; T11_105 — 14 legs,
  ONE bad, and that one is the internal call it shared WITH 103**; T11_107 / T11_102 clean
  on the same public IP. The five minutes before he complained: 103 outbound rx **37%**,
  103 outbound rx **34%**, **103→105 internal rx 49% / tx 48%**, then the chat opens.
  **The complainant's line was fine; the phone at the other end of his internal calls was
  losing a third of its packets.** Ext 103 = "Shlomie folkowits", LAN **192.168.50.200**
  (read from the contact's `call_id` — the documented private-address trick).
- ⛔ **"11 answered calls were very short — the classic one-way-audio signature" did not
  describe his calls.** All **17 incoming answered, none missed**, talk times
  `9…1415 s`, thirteen over a minute, longest **23½ minutes**, exactly one under 15 s —
  and every incoming call carrying RTP measured **0% loss both ways**, including one
  **twelve minutes before he complained**. **Nobody stays on a line 23 minutes when they
  cannot hear.** The short calls were in the OUTBOUND set, which is ordinary.
- ⛔ **THREE OF THE FOUR PROPOSED PBX CHANGES WERE ALREADY TRUE.** Live
  `pjsip show endpoint T11_105`: `rewrite_contact`, `rtp_symmetric`, `force_rport` all
  **already `true`**; the codec pin was a no-op (every sampled leg already ran ulaw); and
  `direct_media: true` is already suppressed by **`disable_direct_media_on_nat: true`**,
  with the RTP counters proving media went through the PBX on the bad call anyway.
  **Read the endpoint before proposing the standard NAT fix** — on this platform it is
  usually already applied, so it cannot be the explanation for the symptom.
- ⛔⛔ **"Ask the customer to sign out of the web app" is WRONG ADVICE and would cost him
  his mobile.** `T11_105` (desk) and `T11_105_1` (app) are separate endpoints on separate
  AORs — the normal shape for **every** extension here, `max_contacts=5`. They do not
  "both take the call leg" and clip audio; one answers.
- ⛔⛔ **"They run filtered internet like most of our accounts" is FALSE for this site —
  the customer denied it and the registration history proves them right.** `whois
  69.118.75.72` → **Optimum Online `OOL-CPE-WRWKNY`, Hicksville NY** — a customer-premises
  cable address. ✅ The whois test is VALID here only because Trimpro is **not** on the 443
  route (`webrtcRouteViaSbc: false`) — check that flag first, or the contact IP is loopcom
  and tells you nothing about the customer.
- ✅✅ **THE DECISIVE CHECK IS REGISTRATION CHURN, NOT WHOIS** — a filtering proxy rotates
  addresses and ports constantly (Luxure: 128/day across six addresses in a /20). Over 10
  days at 69.118.75.72: **ONE address, never rotating** — T11_105 **4** events, T11_105_1
  **10**, T11_107 **10**. A clean, stable line with no proxy in the path.
  ⛔⛔ **And it is a SECOND independent finger at the same phone: T11_103 logs 60 events,
  6/day, and goes UNREACHABLE 29 times** while its siblings on the same wire barely move.
  A device that misses keepalives AND loses 37% of its RTP is a device fault.
  ⛔ The whois rules out a proxy in the PATH; it cannot rule out a filter on the customer's
  own router or DNS. **The churn data is what settles it.**
- ⚠⚠ **WHERE THE REPORT GOT THE IDEA — one Trimpro user IS behind a filter, at a DIFFERENT
  site: `T11_108_1` (Yitzchok Hollender) at `169.61.99.50` = **SoftLayer / IBM Cloud**,
  **5,367 registration events in 10 days (537/day, 1,334 distinct ports)**, `Unavail` now.**
  That is the textbook filtered-internet signature. The report applied one user's situation
  to the site that complained — [[agent-reports-borrow-other-tenants-facts]] inside a single
  tenant. ⏳ **Ext 108 is a real, separate problem and nobody has looked at it.**
- ⛔⛔ **HAD ANYONE ACTED ON IT, THE BLAST RADIUS WAS PLATFORM-WIDE.** These endpoints
  inherit from template `(p1)`, so a per-endpoint override is **not durable** (a tenant
  regen wipes it — the Landau Home opus case), and making the edit **through the VitalPBX
  panel fires Apply Changes**, which regenerates every tenant with pending changes and
  **wipes the Connect doorway** → dead air for A plus center / Connect Communications /
  inii mini. Any endpoint edit here is a surgical conf edit + `module reload
  res_pjsip.so`, or `applyAndRebake`.
- ⛔ **Query traps that each produced a wrong answer first:** `ConnectCdr.direction` is
  `incoming` / `outgoing` / `internal` — filtering on `"inbound"` returns **zero** and
  reads like the customer has no incoming calls; `channelsSeen` is **Json, not a string
  array** (`has:` throws); and there is **no `extension` column** on `ConnectCdr`.
- ⚠ **Coverage caveat, to be stated rather than hidden:** `RtpStatsSampler` samples every
  10 s over **active calls only**, so short calls carry no row (14 of 48 for ext 105).
  Report a census as "of sampled legs", never "of all calls".
- ⛔⛔ **WHAT ACTUALLY HAPPENED — and "faulty wire" was a lazy answer the data argues
  against. It starts with a SITE OUTAGE on Tue 2026-08-24 at 07:40 EDT:** all three phones
  (103, 105, 107) went unreachable **within 25 seconds of each other** and stayed down
  **~22 minutes**. ✅ **That was THEIR site, checked not assumed** — platform-wide that
  45-min window logged **46** UNREACHABLE against a 15-day **median of 42**, and Asterisk
  had been up since Aug 19. ⛔ **Never read a raw cross-tenant event count as an outage** —
  53 events across 11 tenants looked alarming until compared against the baseline.
  **105 and 107 recovered clean; 103 has degraded every day since** — dropped keepalives
  3 (24th) → **12** (25th, all inside 13:09–14:55 EDT) → 5 by early afternoon (26th), with
  RTP loss tracking the same curve 21% → 15% → **34/37/49%**.
- ⛔⛔ **THE 27-SECOND QUANTISATION IS HOW TO READ ANY QUALIFY DATA: 34 outage windows,
  median 27 s, mode 27, outliers only 57/59/87/87 — exactly 2 and 3 of the same unit.**
  With `qualify_frequency 30` / `qualify_timeout 3`, **27 s IS ONE LOST OPTIONS PACKET**
  (3 s to time out, cleared at the next 30 s poll). The phone is **not** going offline for
  half a minute — it drops individual packets in bursts and the keepalive machinery
  quantises that into apparent 27-second outages. Only **0.08% of ~43,200 qualifies** in
  15 days, so the loss is **bursty, not constant**.
- ⛔ **The loss originates AT 103 in BOTH directions** (rx 49% / tx 28%), and **105's
  apparent 48% is INHERITED** — the PBX received half of 103's audio and forwarded the
  gaps, so 105's RTCP reports them as loss. 105's own uplink was flawless.
  ⛔⛔ **That rules out the WAN, the ISP and anything site-wide: at 13:24:31 exactly, 105
  was on that same call through that same router and lost 0%.**
  ⚠ **Jitter stayed 4–9 ms even at 49% loss** — congestion and marginal cabling both RAISE
  jitter; clean loss at low jitter means packets discarded outright, which points away
  from a bad cable and away from bandwidth contention.
- ⚠ **Leading hypothesis (stated as one): an IP conflict on `192.168.50.200`.** Two hosts
  answering one address split traffic roughly in half — which is what 49%/28% looks like —
  low jitter, bursty, one host only, **starting right after a network restart re-shuffled
  DHCP**, worsening as more devices come online daily. **103 sits at `.200`, a very common
  DHCP-pool start address**; its healthy siblings are `.205` and `.233`. Also open: it may
  have come back on **Wi-Fi** after the outage (T34W has built-in Wi-Fi), or something is
  daisy-chained through its **PC passthrough port**.
- ⚠ **Model, subnet and firmware are all RULED OUT:** all three are Yealink **T34W** on
  `192.168.50.x` — 103 fw `124.86.0.77`, 105 fw `124.86.0.75`, 107 fw `124.86.0.115` — and
  **105 is on an OLDER build than 103 and is clean**. ✅ Private addresses come from each
  contact's **`call_id`** (`pjsip show contact <aor/uri>`), the documented trick.
- ⚠ **103 holds the router's external port 5060** (105 and 107 were remapped to 43093 /
  59482 — all three use local 5060, so the NAT gave the first registrant the match).
  **If that router runs SIP ALG, 103 is the only phone it touches.** Worth switching off.
- ⛔⛔ **IT SELF-CLEARS, AND THAT IS HOW THIS GETS MISREPORTED AS FIXED.** Re-checked at
  15:39 EDT the same day: **103 quiet since 13:31** (2h08m, no dropped keepalives) and its
  last sampled call — **15:32 EDT, 103→102, 2m21s — ran 0% loss both ways**; 5 drops today
  vs 12 yesterday. **Nothing was changed, so this is remission, not repair** (yesterday's
  episode 13:09–14:55 EDT, today's 13:19–13:31). ⚠ **And it flips within SECONDS:**
  `13:24:12` a call at **0%**, then `13:24:31` — nineteen seconds later — at **49%**.
  **One good test call proves nothing here.** ⚠ Drops are not purely business-hours
  (03:42 / 03:51 / 00:37 / 23:20 EDT also appear), which fits an always-on cause (IP
  conflict, Wi-Fi) better than a person arriving. ⚠ And `no-rtp` on short calls means
  **not sampled**, never **no loss**.
- ✅ **What to ask them, in order, all free:** (1) what happened at the office Tue 08-24
  ~07:40 EDT; (2) is anything else using `192.168.50.200`, and is that phone on Ethernet
  or Wi-Fi — give it a fresh//different address and watch; (3) turn SIP ALG off.
  **Nothing to change on our side.** ⏳ **NOT PROVEN: nobody has touched that phone**, and
  no follow-up call has been made to Shia.
- ⏳ **The durable fix is to give the escalation researcher `rtpStats`** — `investigate`
  can read it today and the researcher simply does not know to. Until then this class of
  report will keep pointing at NAT.
