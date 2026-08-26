# Trimpro "incoming calls not clear" (ext 105) — the impaired phone is ext 103

**Read-only investigation, 2026-08-26. No code, no deploy, no PBX write, no data change.**
Escalation ref **Y6GQZ8**, Shia Weinstock (`shia@trimprony.com`), opened 2026-08-26
13:28 ET. Tenant `Trimpro` = `cmnlgryjk0003p9pabtu1z1oj`, PBX tenant **11**.

## 1. The assistant's report was confidently wrong, and the evidence was already in our DB

The support-desk researcher filed: *"one-way / dropped audio (SIP ALG or NAT)"*, blamed
the customer's router, proposed four PJSIP changes, and stated **"There is no per-call
quality data tied to extension 105."**

That last sentence is the root of every wrong conclusion. **`ConnectCdr.rtpStats` has
carried per-leg, per-channel loss / jitter / RTT since `a9008ac1` (2026-08-23).** The
researcher looked only at `VoiceDiagEvent` (client self-reports, all filed against one
user id — hence its honest "I cannot prove these rows are Shia's" caveat), concluded no
data existed, and reasoned from call durations instead.

**14 of ext 105's 48 calls carry `rtpStats`, including the bad one.**

## 2. What the measurements actually say

**Ext 105, 7 days: 48 calls — 17 incoming, 29 outgoing, 2 internal.**

All **17 incoming calls answered**, none missed. Talk times, seconds:
`9, 26, 38, 50, 86, 101, 119, 137, 218, 247, 266, 279, 516, 966, 978, 1309, 1415`.
Thirteen ran over a minute, the longest **23½ minutes**, exactly **one** under 15 s.
⛔ The report's *"11 answered calls were very short — the classic one-way-audio
signature"* does not describe his incoming calls at all. **Nobody stays on a line 23
minutes when they cannot hear.**

**Every incoming call carrying RTP measured 0% loss both ways**, jitter 4–13 ms, RTT
25–44 ms — including two the same afternoon he complained (11:45 ET, 101 s; **13:16 ET,
247 s — twelve minutes before he opened the chat**).

### The per-endpoint census is the whole answer

| endpoint | legs | legs ≥5% loss | worst rx | worst tx | avg rx |
|---|---|---|---|---|---|
| **T11_103** | 49 | **7** | **49%** | 28% | **3.4%** |
| 0001 (trunk) | 61 | 4 | 0% | 42% | 0.0% |
| 344022_Comfortcont | 11 | 2 | 0% | 11% | 0.0% |
| **T11_105** | 14 | **1** | **0%** | 48% | **0.0%** |
| T11_107 | 18 | 0 | 0% | 0% | 0.0% |
| T11_102 | 3 | 0 | 0% | 0% | 0.0% |

⛔⛔ **Every degraded leg in seven days belongs to ext 103 — and ext 105's single bad leg
is the internal call it shared WITH 103.** Every other 105 leg is 0%.

**The five minutes before he complained:**
- `17:19:56Z` 103 outbound → trunk, 32 s — 103 rx **37%**
- `17:23:08Z` 103 outbound → trunk, 42 s — 103 rx **34%**
- `17:24:31Z` **103 → 105 internal**, 26 s — 103 rx **49%**, 105 tx **48%**
- `17:28`   Shia opens the support chat

Also degraded on 24, 25 and 26 Aug — all 103. **Ext 103 = "Shlomie folkowits"**, a hard
phone at `69.118.75.72:5060`, LAN address **192.168.50.200** (read from the contact's
`call_id` — the documented trick for a device's private address).

⛔ So Shia's complaint is real and his line is fine: **when he talks to Shlomie, a third
of the audio is gone, and the loss is on Shlomie's phone.**

## 3. The proposed fix was mostly a no-op, and one item was harmful

Live `pjsip show endpoint T11_105` **before** any change:

| proposed | actual |
|---|---|
| `rewrite_contact = yes` | **already `true`** |
| `rtp_symmetric = yes` | **already `true`** |
| `force_rport = yes` | **already `true`** |
| `direct_media = no` | `true` — **but `disable_direct_media_on_nat = true`**, so already suppressed for a NAT'd device, and the RTP counters prove media went through the PBX on the bad call anyway |
| pin codec to ulaw | **every sampled leg already ran ulaw** |

⛔ **"Ask Shia to sign out of the Connect web app" is wrong advice.** `T11_105` (desk) and
`T11_105_1` (app) are separate endpoints on separate AORs — the normal shape for every
extension on this platform, `max_contacts=5`. They do not "both take the call leg"; one
answers. It would cost him his mobile and change nothing.

⛔⛔ **"Trimpro runs filtered internet" is FALSE for this site — the customer denied it and
the registration history proves them right.** `whois 69.118.75.72` → **Optimum Online**,
`OOL-CPE-WRWKNY`, Hicksville NY — a customer-premises cable address, not a proxy. And
Trimpro is **not** on the 443 route (`webrtcRouteViaSbc: false`), so the contact IP really
is the customer's own and the whois test is valid here.
✅ **The decisive check is registration CHURN, not whois** — a filtering proxy rotates
addresses and ports constantly (Luxure: 128 registrations/day across six addresses in a
/20). Over **10 days** at 69.118.75.72:

| endpoint | events | /day | distinct IPs | UNREACHABLE |
|---|---|---|---|---|
| T11_105 | 4 | 4.0 | **1** | 1 |
| T11_105_1 | 10 | 1.1 | **1** | 3 |
| T11_107 | 10 | 1.6 | **1** | 4 |
| **T11_103** | **60** | **6.1** | **1** | **29** |

**One address, never rotating, for ten days.** That is a clean, stable line — there is no
proxy in the path.
⛔⛔ **AND THIS IS A SECOND, INDEPENDENT FINGER AT THE SAME PHONE: ext 103 churns six
times as much as its siblings on the same wire and goes UNREACHABLE 29 times**, while
105 and 107 barely move. With `qualify_frequency 30` / `qualify_timeout 3`, UNREACHABLE
means it stopped answering keepalives. A device that misses keepalives **and** loses 37%
of its RTP is a device/link fault, not a network-wide one.
⚠⚠ **WHERE THE REPORT PROBABLY GOT THE IDEA — one Trimpro user IS behind a filter, at a
different site: `T11_108_1` (Yitzchok Hollender), `169.61.99.50` = **SoftLayer / IBM
Cloud** (RIPE `SOFTLAYER-RIPE-4-30-31`), **5,367 registration events in 10 days — 537/day
across 1,334 distinct ports**, and `Unavail` right now.** That is the textbook
filtered-internet signature. The report took one user's situation and applied it to the
site that complained — the [[agent-reports-borrow-other-tenants-facts]] shape, inside a
single tenant. **Ext 108 is a real, separate problem and nobody has looked at it.**
⛔ **Honest limit of the whois test:** it rules out a filtering PROXY in the path. It
cannot rule out a content filter running on the customer's own router or DNS, which would
still present their own ISP address. The churn data is what settles it here.
⛔ **None of this changes the diagnosis either way.** A filter on the line cannot explain
why one phone loses 37% while three phones on the same connection lose 0%.

⛔⛔ **Safety, had anyone acted on it:** these endpoints inherit from template `(p1)`, so a
per-endpoint override is not durable — a tenant regen wipes it (the Landau Home opus
case). And making the edit **through the VitalPBX panel fires Apply Changes**, which
regenerates every tenant with pending changes and **wipes the Connect doorway** → live
callers on A plus center / Connect Communications / inii mini hit dead air. Any endpoint
edit here must be a surgical conf edit + `module reload res_pjsip.so`, or `applyAndRebake`.

## 3b. WHAT ACTUALLY HAPPENED — it starts with a site outage on Tue 2026-08-24

⛔⛔ **"Faulty wire" was a lazy answer and the data argues against it.** The real shape:

**Tue 2026-08-24, 11:40 UTC (07:40 EDT) — ALL THREE phones at the site went unreachable
within 25 seconds of each other and stayed down ~22 minutes.**

| endpoint | went unreachable | came back |
|---|---|---|
| T11_107 | 11:40:10 | 12:02:22 |
| T11_105 | 11:40:21 | 12:01:42 |
| T11_103 | 11:40:35 | 12:03:35 |

✅ **That was THEIR site, not us — checked, not assumed.** Platform-wide that 45-minute
window logged **46** UNREACHABLE events against a 15-day **median of 42** (p95 97, max
132) — completely ordinary — and Asterisk has been up since Aug 19 with no restart.
⛔ **Do not read a raw cross-tenant event count as an outage** — 53 events across 11
tenants in that window looked alarming until it was compared against the baseline.

**105 and 107 recovered clean. 103 has degraded every day since:**

| day | 103 dropped keepalives | worst RTP loss on a 103 call |
|---|---|---|
| Aug 12–20 | 1–4/day, scattered | — (sampler only starts Aug 23) |
| **Aug 24** (outage day) | 3 | **21%** |
| **Aug 25** | **12**, all inside 13:09–14:55 EDT | 15%, 5% |
| **Aug 26** | 5 by early afternoon | **34%, 37%, 49%** |

The 49% is the 103→105 call at 13:24 — **three minutes before Shia opened the chat.**

### The 27-second quantisation is the key to reading this

⛔⛔ **Every "outage" is 27 seconds, with almost no variance** — 34 windows, median **27**,
mode 27, and the only outliers are 57 / 59 / 87 / 87, i.e. **2 and 3 of the same unit**.
With `qualify_frequency 30` / `qualify_timeout 3`, **27 s is exactly one lost OPTIONS
packet** (3 s to time out, then clear at the next 30 s poll). **The phone is not going
offline for half a minute — it is dropping individual packets in bursts**, and the
keepalive machinery quantises that into apparent 27-second outages. Overall that is only
**0.08% of ~43,200 qualifies in 15 days**, so the loss is bursty, not constant.

### The loss originates AT 103, in both directions

On the 13:24 call: `T11_103` rx **49%** / tx **28%**; `T11_105` rx **0%** / tx 48%.
⛔ **105's 48% is INHERITED, not its own** — the PBX only received half of 103's audio and
forwarded the gaps, so 105's RTCP reports them as loss. 105's own uplink was flawless.

⛔⛔ **This rules out the WAN, the ISP and anything site-wide: at 13:24:31 exactly, 105
was on that same call through that same router and lost 0%.**

⚠ **Jitter stayed at 4–9 ms throughout, even at 49% loss.** Congestion and marginal
cabling both raise jitter as packets queue and retry. **Clean loss at low jitter means
packets are being discarded outright**, which points away from a bad cable and away from
bandwidth contention.

### Leading candidate, stated as a hypothesis

**An IP conflict on `192.168.50.200`.** Two hosts answering for one address split traffic
roughly in half — which is what 49% / 28% looks like — with low jitter, in bursts, for
that host only, **beginning right after a network restart re-shuffled DHCP**, and
worsening as more devices come online each day. ⚠ **103 sits at `.200`, a very common
DHCP-pool start address**, while its healthy siblings are at `.205` and `.233`.

Also open, same evidence: it may have come back on **Wi-Fi** rather than Ethernet after
the 22-minute outage (the T34W has built-in Wi-Fi), or something is now daisy-chained
through its **PC passthrough port**.

⚠ **All three phones are the SAME model (Yealink T34W) on the SAME subnet** — 103
`192.168.50.200` fw `124.86.0.77`, 105 `192.168.50.233` fw `124.86.0.75`, 107
`192.168.50.205` fw `124.86.0.115` — so model and subnet are both ruled out, and firmware
does not sort them (105 is on an OLDER build than 103 and is clean). Private addresses
read from each contact's `call_id`.

⚠ **One more fact worth acting on: 103 is the phone holding the router's external port
5060** (`69.118.75.72:5060`) while 105 and 107 were remapped to high ports (43093, 59482)
— all three use local 5060, so the NAT gave the first registrant the matching external
port. **If that router runs SIP ALG, 103 is the only phone it touches.**

### It self-clears — which is exactly how this gets misreported as fixed

Checked again at **15:39 EDT** the same day. **103 has been quiet since 13:31 EDT** — no
dropped keepalives in 2h08m, and its last sampled call (**15:32 EDT, internal 103→102,
2m21s**) ran **0% loss both directions**. Today totalled **5** dropped keepalives against
**12** yesterday.

⛔⛔ **NOTHING HAS BEEN CHANGED, so a quiet afternoon is not a fix.** Yesterday's episode
ran 13:09–14:55 EDT and today's ran 13:19–13:31 — it burns out on its own and comes back.
**Do not let "it seems fine now" close this case.**

⚠ **And it flips within SECONDS, not minutes** — today, back to back on the same phone:
`13:24:12` a 7-second call at **0% loss**, then `13:24:31`, nineteen seconds later, the
call to Shia at **49%**. Any test that takes one good call as proof will pass while the
fault is still there.

⚠ **The drops are NOT purely business-hours**, which weakens "somebody plugs a laptop in":
there are 03:42, 03:51, 00:37 and 23:20 EDT drops in the 15-day history alongside the
afternoon clusters. A device that is always on — an IP-conflicting host, or a Wi-Fi link
— fits that better than a person arriving.

⚠ **Sampler coverage caveat again:** several of today's 103 calls read `no-rtp` simply
because they were too short for the 10 s sampler. **"No row" is not "no loss."**

## 4. What to actually do

1. **Ask what happened at the office on Tue 26-08-24 around 07:40 EDT** — power cut,
   internet outage, anyone working on the network. That is when this started, and nothing
   before it looks like this.
2. **On Shlomie's phone (T34W, `192.168.50.200`): is anything else on the network using
   that address, and is the phone on Ethernet or Wi-Fi?** Cheapest test in the building:
   give it a different address outside the DHCP pool (or let it take a fresh lease) and
   watch whether the dropped keepalives stop.
3. **Turn SIP ALG off on the router.** Good hygiene regardless, and 103 is the one phone
   exposed to it.
4. **Nothing to change on our side.** The PBX settings the report wanted are already
   correct, and Shia's own line and phone are provably clean.
5. Tell Shia the trouble is at the other end of his internal calls — he is not imagining
   it, and it is not his phone.

## 5. Coverage caveat, stated rather than hidden

`RtpStatsSampler` runs every 10 s over **active calls only**, so short calls carry no
row — 14 of 48 for ext 105, 49 legs for 103. The census above is of sampled legs, not of
every call. It is still per-call truth about the calls it did sample, which is what the
report said did not exist.

## 6. Follow-up worth doing

**Give the escalation researcher `ConnectCdr.rtpStats`.** It reasoned from durations and
blamed a router because it could not see loss data it already had. `investigate` can read
it today — the researcher simply does not know to. Until then this class of report will
keep pointing at NAT.
