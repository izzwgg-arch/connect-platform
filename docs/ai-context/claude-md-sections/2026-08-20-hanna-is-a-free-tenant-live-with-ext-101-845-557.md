# ⛔ AGENT HANDOFF — "Hanna" is a FREE tenant: LIVE with ext 101 + (845) 557-7194 + SMS, and NO billing row ON PURPOSE (2026-08-20) — READ FIRST before touching tenant `cmt1qoxrq0004o8myjoq13m21`, before "fixing" its missing billing, or before re-running onboarding into a stale REST tenant list

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_HANNA_FREE_TENANT_2026-08-20.md`**
(All live on prod 2026-08-20; no deploy, no code change, no migration. PBX
writes rode the sanctioned onboarding build.) Izzy: *"Do not create a bill for
her. I'm not charging her."*

- ✅ **Built through the REAL onboarding path** (submission
  `cmt1qcpsk0000o83x8meneh5c`, `paidAt` null on purpose): PBX tenant **141**
  `hanna_eneh5c` via the mirror, ext **101 "Hanna Weber"** (desk + WebRTC, SIP
  synced), trunk 166 / outbound route 162 / inbound `_8455577194 →
  T141_cos-all,101`; spare-stock DID **845-557-7194** routed to subaccount
  `344022_Hannaeneh5c`; user **chaniweb16@gmail.com** = TENANT_ADMIN, INVITED,
  invite email **SENT**; `TenantSmsNumber` assigned (ext 101, tenant default)
  and **proven in the worker poll**; 443 SIP route (`sipDomain` corrected to
  the hostname — new tenants get the raw PBX IP stamped there, same fault the
  2026-08-10 handoff fixes).
- ⛔⛔ **THE FREE-ACCOUNT MECHANISM: she has NO `TenantBillingSettings` row —
  the orchestrator's billing stamp was deliberately skipped, so the invoice
  engine structurally cannot bill her. Never "repair" it.** 0 invoices,
  verified.
- ⛔ **The orchestrator failed at `pbx_tenant_not_in_directory` because the
  VitalPBX REST tenant LIST is a stale cache (28 vs MySQL's 29)** — and
  `findPbxDirectoryEntry`'s own re-sync DELETES a hand-seeded directory row, so
  re-running can't work while stale. **The per-tenant REST reads are NOT
  stale** — the recipe that worked (`/root/hanna-continue.ts` on loopcom):
  seed `PbxTenantDirectory` from `ombu_tenants` (MySQL truth), then replay the
  orchestrator's remaining steps verbatim, skipping the billing stamp.
  ⏳ Follow-up not done: give `findPbxDirectoryEntry` a MySQL fallback — this
  bites any sign-up that lands during a stale window.
- ⛔ **(845) 557-7194 has NO E911** (no address given — registration skipped,
  loudly, on the timeline). 911 does not work from this account until Izzy
  supplies her address. Also the known duplicate-voicemail-email gap applies
  (her email is on the PBX extension AND in Connect).
- ✅ **INTERNATIONAL CALLING IS UNLOCKED ON HER SUBACCOUNT — HERS ONLY (Izzy,
  2026-08-23: "enable international calling for Hannah Weber only").**
  `setSubAccount` on `344022_Hannaeneh5c` (id 840905) flipped
  `lock_international` `1 → 0`; `international_route` stays `1`; verified by
  re-read (`lock_international: "0"`, password byte-unchanged). ⛔ Every OTHER
  subaccount stays locked — onboarding creates them `lock_international: "1"`
  on purpose (`voipMsProvisioning.ts`); do not copy this unlock to anyone
  without Izzy's word. ⛔ International minutes bill the MASTER VoIP.ms account
  and Hanna is a FREE tenant with no billing row — the cost is absorbed, by
  design (Izzy re-confirmed 2026-08-23: "I'm not charging her").
  ✅ **The PBX half is VERIFIED too (read-only, 2026-08-23):** her outbound
  route `trk-group-162` in the live rendered Main dialplan carries **`_011.`**
  beside the NANPA patterns (ARS 289 → trk-group-162 → trunk 166, CID
  8455577194) — onboarding put it there; nothing was written. ⏳ No
  international call has been placed yet — that is the acceptance test.
  ⛔ **"Every outbound route has 011" is NOT true fleet-wide: 37 of 58
  trk-group contexts carry `_011.`, 21 do not** (mostly pre-Connect-era
  routes: A Plus Center, Smart Steps, KJ Play Center, Quick Sat Rental,
  Fleetease, Kitchens of USA, Silver Birch, Onveo, Avenue Filing, SpaceArt,
  Sterlion Creations, Rollup, Koznits Catering, trust smooth, spam test,
  McNamara Lion, landau home caller id, Trust Sge, Tellocall, Loopcom,
  YS Plumbing). Harmless today — their subaccounts are all still
  international-locked at VoIP.ms — but unlocking a customer on one of those
  21 routes fails at the DIALPLAN, not the carrier. Fixing them is a panel
  edit per route (PBX write, needs Izzy).
- ⏳ **TestFlight: added to "Loopcom Testers" (Hanna Weber, build 52) and
  `/v1/betaTesterInvitations` answered 201 TWICE, but the tester still read
  `NOT_INVITED`** — confirm the email reached her; re-run
  `node /root/.appstoreconnect/asc-invite-hanna.mjs` if not.
- ⏳ **Not proven:** no call, no text, no login, no TestFlight install yet.
