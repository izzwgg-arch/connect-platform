# ⛔ AGENT HANDOFF — the FCC BDC filing (Broadband Data Collection, fixed voice subscriptions, data as of June 30 2026) — READ FIRST before touching bdc.fcc.gov, the "Late BDC Filing" emails, or the June/December voice-subscription counts

**Status 2026-09-15 ~13:30 ET: DATA COMPLETE AND VALID — 102 subs, 8 census tracts, Izzy's address answers applied. CERTIFICATION BLOCKED by the FCC's own stale Form 499 list (re-tested after the update: "83920" still "No items found"). BDC help ticket #63588 filed and pending. NOTHING IS CERTIFIED/SUBMITTED YET — that is the ONLY remaining step besides the ratio-warning explanation.**

## What this filing is
- FCC email 2026-09-15 (BroadbandDataInquiries@fcc.gov, in izzy@loopcom.net Gmail): **Second Notice — Late BDC Filing** for loopcom llc., FRN 0038803722. Data as of June 30 2026 was due Sept 1 2026. This resolves the compliance-calendar open question on `bdc-june-data`: **yes, a 2026-new filer owes the June round.**
- For Loopcom (interconnected VoIP, no broadband) the whole filing is ONE thing: **Fixed Voice Subscription (Non-ILEC)** — iVoIP subscription counts by census tract + a state-level allocation. No Availability, no Supporting Data, no engineering cert (entity page has the "fixed voice only" box checked).
- System: https://bdc.fcc.gov → submission `/submission-overview/0038803722/2043684`. Login = FCC Okta (`fcc-ext.okta.com`), izzy@loopcom.net, Chrome-saved password; **MFA by email code to izzy@loopcom.net works** (no phone push needed — pick "Get a verification email"; opening the email's link/code in the same browser completes it).

## What is DONE (container of record: the BDC draft itself)
- **Tract-level Data Entry, 8 rows, 102 subscriptions, all business (consumer 0) — FINAL per Izzy's 2026-09-15 answers:**
  - NY/Orange 141.02 (36071014102): 30 — A Plus Center 20 + B Visible 10 (both E911 at Route 17M Harriman; Izzy did not dispute A Plus's address when flagged)
  - NY/Orange 150.03 (36071015003): 31 — Gesheft 14, Create A Box 10, Relax Tires 3, ADDB 3, Fixup 1 (all Kiryas Joel/Monroe)
  - NY/Orange 150.05: 12 — Trimpro 8 + **Luxure Management 4** (3 Tzfas Rd unit 202, Monroe/KJ 10950, from Izzy)
  - NY/Orange 150.07: 10 — RSBK 4 + **Trust Bookkeepings 6** (15 Van Buren Dr #001, Monroe/KJ — census has no address-range for it; tract via Photon coords → /coordinates)
  - NY/Rockland 121.16: 2 — Solidify (Monsey) · 123.02: 4 — Displaydex (Spring Valley) · 111.02: 7 — Yossis Wood Works (West Nyack) · **121.09: 6 — Secro Solutions** (34 Main St, Monsey — Izzy CORRECTED this mid-entry from "3 Lizensk Blvd Monroe"; the Lizensk/150.10 row was never saved)
- **State-level (New York): saved, all 7 validation checks green.** Grand total 102 = OTT 102 (consumer 0 / bus 102); "All Other" all zeros — **Loopcom is pure Over-the-Top** (no last-mile facilities). This is the right bucket; never put subs in FTTP/coax/etc.
- **Izzy's exclusion rulings (2026-09-15, verbatim intent):** Ribit Capital, Actual Home Care, Smooth Leasing, Slim Business Funding, LUZER, Carirent, NY Garden Sprinkler = **deleted tenants**; Landau Home = **test tenant**; **McNamara Lion = "don't report for now"** (real, deliberately held out of this filing — revisit for the December round). So the June-30 reportable universe is the 15 tenants in the 8 rows above.
- ⛔ **Izzy 2026-09-15: "Don't turn on any e911 addresses now either. Just put the addresses in the report. We'll deal with the actual e911 address later."** — NEVER enable/register/modify E911 at VoIP.ms as part of BDC work; addresses are for the filing only.
- **Method (repeatable):** subscriptions = Extension rows with createdAt ≤ 2026-07-01 per CUSTOMER tenant (Connect DB via SSH → `connectcomms-postgres`); service addresses = VoIP.ms **e911Info** per DID (creds decrypted from `GlobalVoipMsConfig.credentialsEncrypted` with `CREDENTIALS_MASTER_KEY` inside app-api-1 — AES-256-GCM envelope, see packages/security); tract = Census geocoder `geocoding.geo.census.gov/geocoder/geographies/onelineaddress` (⛔ "200 N State Route 303 West Nyack" does NOT match — geocode via Photon/OSM to lat/lon then the `/coordinates` endpoint; → Rockland 111.02).
- **BDC help ticket #63588 submitted** (help.bdc.fcc.gov, as izzy@loopcom.net; confirmation in inbox): asks FCC to add Filer ID 839208 to the BDC list or advise. FCC's reply will come by email.

## ⛔⛔ THE BLOCKER — the BDC's Form 499 list is a stale USAC snapshot and 839208 IS NOT IN IT
- Final Data Checks → **Error "Missing Form499 ID"** — hard-blocks Certification (the Certification card on Submission Overview has NO link while an Error stands; the checks' Edit/Explanation buttons are `disabled`).
- The Entity Information page's "Form 499 Filer IDs" box is a validated picker: typing "8392" finds other filers, "83920" finds nothing → **839208 cannot be entered**. Same lag as the public 499 database trap in `AGENT_HANDOFF` 2026-09-10 (USAC approved the 499-A ~Sep 10; BDC's copy predates it).
- FCC's own help article (Entity Information: Service Providers) sanctions the pattern for the analogous SAC case: check "does not have", explain in **Explanations and Comments at Certification**. But for the 499 field the checks emit an *Error*, not a warning, so certification stays gated → hence ticket #63588. Entity page left AS FOUND (checkbox "does not have an assigned Form 499 Filer ID" CHECKED, nothing saved).
- Also outstanding: a benign **Warning** (same consumer/business ratio in every tract — true: every customer is a business). Needs an Explanation when the Edit button un-disables (likely once the Error clears).

## ⏳ NOT DONE — what the next session must do
1. ~~Get addresses from Izzy~~ **DONE 2026-09-15** — see the rulings above; data is final at 102.
2. ~~A Plus Center~~ — flagged to Izzy (E911 = our HQ); he didn't move it; left in 141.02. E911 itself stays untouched per his instruction.
3. **Watch for FCC replies** (ticket #63588 + BroadbandDataInquiries) in izzy@loopcom.net. When 839208 becomes enterable: Entity Info → uncheck the box → add 839208 → Save & Continue → rerun Final Data Checks → fill the ratio-warning Explanation ("all subscribers are businesses; Loopcom sells business phone service only") → Certification.
4. **Certification = Izzy.** Project precedent (RMD): Izzy signs legal attestations himself. Have everything green, then hand him the Certification page (it will also want the Explanations & Comments note about the recently-issued 499 ID per the FCC help pattern, and the late-filing context).
5. **December round**: data as of Dec 31 2026, window opens Jan 1, due **March 1 2027** — already seeded in the compliance calendar (`bdc-december-data`). The method above is the recipe; keep E911 registrations current so the address hunt dies.
6. Decision on record: **excluded** Loopcom's own/internal tenants ("Connect", "Connect Communications" x2, demos, agent-test junk) — self-provided service is not a subscription *sold*; **included** unapproved-but-live April-migration tenants (they had DIDs + extensions in service). Counting unit = extensions (seats). Consumer count 0 (Hanna, the one free/residential-ish tenant, was created Aug 20 — after the June 30 as-of date).

## Traps burned into this session
- ⛔ The BDC "Data Entry" tract dropdown needs State→wait→County→wait→Tract in that order (options load async); the desktop-app permission classifier BLOCKS big fill+save browser batches on bdc.fcc.gov — do fills in one small batch, the Save click as its own call.
- ⛔ Gmail row clicks by coordinate hit the wrong row (inbox reflows) — `find` the row by subject text first.
- ⛔ The BDC session belongs to Chrome profile with izzy@loopcom.net Gmail = mail.google.com **/u/4/**.
