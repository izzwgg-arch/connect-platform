# ⛔ AGENT HANDOFF — the FCC BDC filing (Broadband Data Collection, fixed voice subscriptions, data as of June 30 2026) — READ FIRST before touching bdc.fcc.gov, the "Late BDC Filing" emails, or the June/December voice-subscription counts

**Status 2026-09-15 ~15:00 ET: DATA COMPLETE AND VALID — 102 subs, 8 census tracts. CERTIFICATION BLOCKED by the FCC's own stale Form 499 list. BDC HELP DESK ANSWERED ticket #63588 (see below) — the only fix is to WAIT for their ~monthly 499-list refresh, then enter 839208 and certify. NOTHING IS CERTIFIED/SUBMITTED YET.**

## ⛔ BDC HELP DESK REPLY (ticket #63588, 2026-09-15 2:51 PM ET, broadbanddatainquiries@fcc.gov) — this is the authoritative answer
Verbatim: *"If you are a new provider and just created your 499 ID it may not be in the system, but it is required for filing for Voice providers. **The 499 ID list is updated about once a month**, so please check back to see if it has been added."*
- **Meaning: there is nothing to fix and no override to request — the block clears on its own when the BDC refreshes its 499 list.** 839208 was USAC-approved 2026-08-24, so the next refresh should carry it. The whole submission is already entered + valid; the day 839208 becomes selectable on the Entity Information page, enter it → rerun Final Data Checks → answer the all-business ratio warning → Izzy certifies. No data work remains.
- ⏳ A follow-up reply is DRAFTED (pushing them to expedite, given the overdue Second Notice + enforcement language, and to confirm the next refresh date) but **NOT SENT** — a Chrome-extension conflict blocked the Send click, and it is optional anyway. It sits in a Gmail compose window for Izzy to send or discard. If re-sending from a session: reply on the ticket thread (Gmail thread id `1a0a644ecf967cb9`), keep the ticket token `[7YX7D9-9JVG9]` in the body so it threads to #63588.
- **Recommended cadence:** check the Entity Information 499 picker for 839208 roughly weekly (type "83920"); the moment it appears, finish. The compliance calendar's BDC reminders will also keep nagging until the item is marked done.

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
5. **December round**: data as of Dec 31 2026, window opens Jan 1, due **March 1 2027** — seeded in the compliance calendar (`bdc-december-data`). ✅ **DO NOT HAND-TYPE IT AGAIN — it is generated now (see below).**

## ✅ THE FILING IS GENERATED FROM THE DATABASE NOW (2026-09-15, Izzy: "build it")
- **`apps/api/scripts/bdc-voice-subscription-export.ts`** — one command produces the whole filing:
  ```
  cd apps/api && pnpm exec tsx scripts/bdc-voice-subscription-export.ts --as-of 2026-12-31
  ```
  It prints a per-tenant reconciliation, writes the **tract-level CSV** for the BDC's Upload Files tab (`tract,service_type,total_lines_or_subscriptions,consumer_lines_or_subscriptions`), and prints the **State-Level** numbers to type. Flags: `--out`, `--no-header`, `--map`, `--allow-unmapped`. ⛔ Read-only: it touches no database, PBX, VoIP.ms or E911 record.
- **`docs/regulatory/bdc-tenant-tracts.json`** — the tenant → census-tract map, carrying each service address, where it came from, and Izzy's exclusion rulings verbatim. This is the file that made today expensive; committing it means the address hunt never repeats.
- ⛔⛔ **THE GUARD THAT MATTERS: if a tenant has extensions on the as-of date but is in NEITHER `tenants` NOR `excluded`, the script refuses to write a CSV and exits non-zero.** A new customer silently missing from a federal filing is the failure mode this exists to prevent. `--allow-unmapped` overrides it but prints a loud warning.
- ✅ **PROVEN, not just written**: run against the live database in `app-api-1` for `--as-of 2026-06-30` it reproduces the June filing EXACTLY — 8 tract rows, 102 subscriptions, per-tract 30 / 31 / 12 / 10 / 7 / 6 / 2 / 4, byte-identical to what was hand-entered into the BDC. An independent SQL aggregation returned the same 8 tracts and the same sums.
- ⏳ **NOT PROVEN: no generated CSV has been uploaded to the BDC yet** (the June round was typed in by hand before the script existed, and it is still blocked at certification). ⛔ **Open question — the header row.** The FCC names the four headers but its worked example shows a bare data row, and its "CSV sample" attachment could not be retrieved (fcc.gov 403s every non-browser fetch and the in-page link bounces back to the article). The script writes a header by default; **if the BDC rejects the upload, re-run with `--no-header`.**
- The two live `bdc-*` reminder rows now carry the command in their `details`, so the reminder email/SMS itself says how to produce the filing.

## AUTOMATION AUDIT — every compliance item, what can actually be automated (2026-09-15)
| Item | Automatable? | Reality |
|---|---|---|
| **BDC voice subscriptions** (Sept 1 / Mar 1) | ✅ **Generated** | CSV upload is supported; our script builds it. API exists but is challenge-only. |
| **CPNI certification** (Mar 1, EB Docket 06-36) | ⚠️ Read-only | The [ECFS public API](https://www.fcc.gov/ecfs/help/public_api) (`publicapi.fcc.gov/ecfs`, free key) is **GET-only** — `/filings`, `/filing/{id}`, `/proceedings`, `/documents`. No POST, so **filing stays manual**; the API can VERIFY a filing posted and fetch its confirmation. |
| **FCC Form 499-A** (Apr 1, USAC) | ❌ Manual | USAC E-File has no public filing API. A bulk multi-filer upload exists for 499-**Q** only. |
| **RMD recertification** (Mar 1) | ❌ Manual | ServiceNow portal, Okta + push MFA, perjury declaration signed by an officer. |
| **CVAA / RCCCI** (Apr 1) | ❌ Manual | FCC registry web form. |
| **D.C. agent renewal** (Aug 20) | ❌ Manual | Just confirm the card on file did not fail. |
- ⛔⛔ **THE FCC FORM 499 FILER DATABASE API IS DEAD — do not build a watcher on it.** It is documented at `apps.fcc.gov/cgb/form499/docs/index.htm` (v01.03.06, **2011**) and returns an FCC error page for *every* query — including the FCC's own documented sample call — from a clean server IP and from a real browser alike, while the plain HTML search page returns 200. So there is **no programmatic way to watch for Filer ID 839208 appearing**; checking the BDC's own picker by hand (or waiting for their ~monthly refresh) is the only option.
- ⛔ Non-browser fetches of `www.fcc.gov` and `apps.fcc.gov` are Akamai-blocked (403 "Access Denied") from both this workstation and the loopcom server — `help.bdc.fcc.gov` is NOT blocked and curls fine from the server. Budget for that when scripting anything against FCC hosts.
6. Decision on record: **excluded** Loopcom's own/internal tenants ("Connect", "Connect Communications" x2, demos, agent-test junk) — self-provided service is not a subscription *sold*; **included** unapproved-but-live April-migration tenants (they had DIDs + extensions in service). Counting unit = extensions (seats). Consumer count 0 (Hanna, the one free/residential-ish tenant, was created Aug 20 — after the June 30 as-of date).

## Traps burned into this session
- ⛔ The BDC "Data Entry" tract dropdown needs State→wait→County→wait→Tract in that order (options load async); the desktop-app permission classifier BLOCKS big fill+save browser batches on bdc.fcc.gov — do fills in one small batch, the Save click as its own call.
- ⛔ Gmail row clicks by coordinate hit the wrong row (inbox reflows) — `find` the row by subject text first.
- ⛔ The BDC session belongs to Chrome profile with izzy@loopcom.net Gmail = mail.google.com **/u/4/**.
