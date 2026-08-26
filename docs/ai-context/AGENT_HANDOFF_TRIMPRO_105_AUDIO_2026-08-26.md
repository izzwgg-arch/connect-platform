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

## 4. What to actually do

1. **Look at the phone on ext 103** (Shlomie, 192.168.50.200): its cable, its switch port,
   its PoE, or its wifi link. One device is losing a third of its packets on its way to
   the PBX while three siblings on the same public IP measure clean.
2. Nothing to change on the PBX. Nothing to change on the router. Nothing for Shia to do.
3. Tell Shia his own line tests clean and the trouble is on the other end of his internal
   calls — he is not imagining it.

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
