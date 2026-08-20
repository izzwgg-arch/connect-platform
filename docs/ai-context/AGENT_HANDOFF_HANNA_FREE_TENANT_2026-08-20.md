# AGENT HANDOFF — "Hanna": a FREE tenant built through the real onboarding path, with the billing stamp deliberately withheld (2026-08-20)

Izzy, 2026-08-20: *"create a new tenant called Hanna with one extension, first
name Hanna, last name Weber. Do not create a bill for her. I'm not charging
her. Take a phone number that we have in stock, the 845 number, and turn on
SMS for it as well, and then send her also a test flight email."*
Email: **chaniweb16@gmail.com**.

Everything below ran live on production 2026-08-20 ~16:25–16:50 UTC. No deploy,
no code change, no migration. PBX writes went through the sanctioned onboarding
build (mirror tenant create + panel extension import) — the same path every
real sign-up takes.

## 1. What exists now — the ids

| | |
|---|---|
| Connect tenant | `cmt1qoxrq0004o8myjoq13m21` "Hanna" (kind CUSTOMER, approved) |
| PBX tenant | **141** `hanna_eneh5c`, path `d971dfafc60e1f19` (created via the mirror) |
| Extension | **101 "Hanna Weber"** (`cmt1qoz32000co8myb3mffnuv`), desk + WebRTC devices, SIP synced |
| User | `cmt1qozae000go8my2rf482pv` chaniweb16@gmail.com — **TENANT_ADMIN**, status INVITED, firstName Hanna / lastName Weber |
| Number | **(845) 557-7194** — was spare stock (ordered 2026-07-07), now routed to subaccount `344022_Hannaeneh5c` |
| VoIP.ms subaccount | `344022_Hannaeneh5c` (creds encrypted on the submission) |
| PBX plumbing | trunk 166, outbound route 162 (CID `"Hanna" <8455577194>`, 0001→VoIP.ms), route selection 289, inbound route `_8455577194 → T141_cos-all,101` |
| SMS | carrier `sms_enabled: "1"`; `TenantSmsNumber cmrfeqczr434gqs127madhztg` → tenant + ext 101, tenant default, active; **worker poll picked it up** (`[voipms-inbound] +18455577194: fetched=0`) |
| Onboarding submission | `cmt1qcpsk0000o83x8meneh5c` — status ACTIVE, pbxSetupStatus done, **paidAt null on purpose** |
| Invite email | `USER_INVITE` to chaniweb16@gmail.com — **SENT 16:33:24Z** (create-password link, 72 h, APK link included) |
| TestFlight | tester `b2859f21-874b-4635-ba5e-6e5241532a32` in "Loopcom Testers" (build 52 attached) — see §4 |
| SIP route | `webrtcRouteViaSbc: true`, `sipWsUrl: null` (→ the global `wss://sip.loopcom.net/sip`), `sipDomain` corrected to `m.connectcomunications.com` |

## 2. ⛔ THE FREE-ACCOUNT MECHANISM — and what must never be "fixed"

**She has NO `TenantBillingSettings` row, deliberately.** The recurring invoice
engine cannot bill a tenant without one (the inii mini precedent: "it must
exist before any recurring lines can be invoiced"). The orchestrator's
`ensureOnboardingBillingDefaults` stamp — which would have set up $30/ext + $5
+ fees and armed the overdue cutoff — was **skipped** in the continuation run.
Verified after: billing settings row **none**, invoices **0**.

- ⛔ **Never stamp billing onto this tenant** without Izzy's word. A later
  reader seeing a live tenant with no billing row must not "repair" it —
  that IS the no-charge design (same shape as Create A Box's free SMS).
- ⛔ `smsBillingEnabled` doesn't exist for her (no row) — and it gates nothing;
  texting works regardless (proven again here).
- The submission's `paidAt` is **null on purpose** — nothing was sold. This
  also means the stranded-paid watchdog will never resume this submission
  (it only sweeps paid rows); it is `done`, so nothing needs to.

## 3. ⛔ The stale-REST-list failure and the continuation recipe

`runOnboardingSetup` built the whole PBX side, then failed at
`pbx_tenant_not_in_directory (slug hanna_eneh5c)`: **VitalPBX's REST tenant
list is a stale cached snapshot** ([[vitalpbx-rest-tenant-list-is-a-stale-cache]])
— MySQL held 29 tenants incl. 141, REST answered 28. `findPbxDirectoryEntry`
re-syncs from REST every attempt and the sync **deletes** directory rows not in
the REST list, so hand-inserting a row and re-running the orchestrator cannot
work while the cache is stale.

**The recipe that worked** (script `hanna-continue.ts`, kept at
`/root/hanna-continue.ts` on loopcom): replay the orchestrator's remaining
steps (setupOrchestrator.ts ~640–770) verbatim — seed `PbxTenantDirectory`
from the MySQL truth row, `ensureConnectTenant` equivalent (link check →
`uniqueTenantName` create + `TenantPbxLink`), `syncExtensionsFromPbx` scoped to
`vitalTenantId`, `verifyAndRepairTenantExtensions`, owner promotion, and a
byte-for-byte copy of the private `queueInviteEmail`. ⛔ **The per-tenant REST
reads are NOT stale** — the extension sync succeeded on attempt 1; only the
tenant LIST is cached. ⛔ The seeded directory row may be deleted by the next
REST-driven sync until the cache catches up — harmless: `TenantPbxLink` is the
durable link, and the row comes back when REST refreshes. The orphan sweep
cannot false-remove the tenant (MySQL ConfirmGone protects it).

⏳ **Obvious follow-up, NOT done:** `findPbxDirectoryEntry` should fall back to
MySQL (`connectOmbutelMysql`) when REST doesn't show a tenant that
`buildPbxTenant` just created — this will bite every future sign-up until the
cache behaviour changes or the fallback lands.

## 4. TestFlight — Apple accepted the invite, state still reads NOT_INVITED

`asc-add-hanna.mjs` added her (201) with firstName Hanna / lastName Weber to
"Loopcom Testers" (`fe508ee6…`, build 52 VALID attached). State stayed
**NOT_INVITED**, so `asc-invite-hanna.mjs` POSTed `/v1/betaTesterInvitations`
— **201 twice**, state still displayed NOT_INVITED minutes later. Every prior
tester flipped to INVITED. Either Apple's state lags or the email is stuck.
**Check with her; if no email arrived, re-run
`node /root/.appstoreconnect/asc-invite-hanna.mjs`** (it re-invites only while
the state is NOT_INVITED/INVITED, so it is safe to repeat).

## 5. ⛔ Open items / honest gaps

- ⛔⛔ **(845) 557-7194 has NO E911** (`e911: "0"`) — no service address was
  given, so registration was skipped (timeline records it) and the PBX
  emergency config was skipped too. **911 does not work from this account.**
  When Izzy has her address: validate → apply `alternatives` → validate →
  provision (`language: "EN"` uppercase), per the onboarding-E911 handoff.
- **Duplicate voicemail emails**: the known onboarding gap — her email is in
  the PBX voicemail conf (3rd comma field) AND Connect mirrors it, so a
  voicemail will email her twice until the PBX field is blanked per the
  voicemail-email cutover procedure (PBX write — needs a mandate).
- ⏳ **Not proven:** nobody has called (845) 557-7194 (acceptance: it should
  ring ext 101 once she registers — or before that, callers hear ring/VM);
  no text in/out yet; she hasn't opened the invite or set a password; the
  TestFlight email is unconfirmed (§4). Endpoints `T141_101`/`T141_101_1`
  are loaded and unregistered — correct until she signs in.
- Scripts kept on loopcom `/root/`: `hanna-setup.ts`, `hanna-continue.ts`,
  `hanna-sms.ts`, `hanna-probe.ts`, `.appstoreconnect/asc-{add,invite}-hanna.mjs`.
  Container copies removed.
