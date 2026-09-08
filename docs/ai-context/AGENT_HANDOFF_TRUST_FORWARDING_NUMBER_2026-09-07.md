# AGENT HANDOFF — a stock number on its OWN subaccount, pointed at an EXISTING tenant's extension (Trust Bookkeepings ext 106, 2026-09-07)

Izzy, 2026-09-07: *"take a phone number that we have in stock and create a
subaccount called Trust 9/7/2026 and pointed to trust bookkeeping extension 106.
We don't need E911 for this. It's a number that's just going to forward calls."*

Everything below ran live 2026-09-07 23:25–01:35 UTC. **No code change, no deploy,
no migration.** One VoIP.ms create + one routing write; three PBX panel writes
(trunk, tenant number list, inbound route) through the SAME onboarding code the
sign-up wizard uses, each Apply followed by a Connect-doorway re-bake.

## 1. What exists now

| | |
|---|---|
| Number | **(845) 557-7735** — was spare stock (ordered 2026-07-07, `routing account:344022`), SMS-capable |
| VoIP.ms subaccount | **`344022_Trust972026`**, id **845044**, device type Asterisk, international locked, description "Trust 972026" (⛔ VoIP.ms strips `/` from descriptions — the name Izzy asked for cannot be stored verbatim; usernames are alphanumeric ≤12 chars, so `Trust972026`) |
| DID routing | `account:344022_Trust972026`, **E911 `0` on purpose** (never touched), failover none |
| PBX trunk | **182 "Trust 9/7/2026"** in Main (tenant 1), `newyork1.voip.ms`, codecs ulaw/alaw/g726/g729 — `pjsip show registrations` → **Registered**, contact **Avail 27 ms**; carrier `getRegistrationStatus` → `registered: yes` from 209.145.60.79 |
| Tenant number list | `ombu_tenant_dids` tenant 18 now holds **9** DIDs (8 + 8455577735); Main's `default-trunk` renders `_8455577735 → Trust Bookkeepings tenant` |
| Inbound route | **314 "Trust 9/7/2026"** on tenant 18: `_8455577735 → Goto(T18_cos-all,106,1)` (ext 106 = panel extension id **93**, "106 - Miss Spilman") |
| Connect | `PbxTenantInboundDid` for the number already synced onto `cmnlgrykx000fp9pa90gohk96` (active); `TenantSmsNumber cmrfeqd0b434uqs12tg7chrb8` exists **unassigned** (`tenantId null`) — texting to this number is NOT wired, by omission not by design; Izzy did not ask for SMS |
| Billing | **Unchanged.** Trust's invoice lists every PBX DID as a `pbx_inbound_did` line at **$0**, extensions are a manual quantity of 5, E911 is a flat $3 — the new number adds one more $0 line |
| Backups | PBX `/root/trust97-before-20260907T232445Z/` (tables.sql of ombu_tenants/ombu_tenant_settings/ombu_tenant_dids/ombu_trunks/ombu_trunk_parameters/ombu_inbound_routes/ombu_destinations + doorway counts); loopcom `/root/trust97/state.json` (600 — the subaccount password; it also lives in trunk 182's `outgoing_remotesecret`) |
| Script | loopcom `/root/trust97-build.ts` (PHASE=a VoIP.ms, PHASE=b PBX; idempotent, resumable) |

## 2. The recipe (reusable for "a number on its own subaccount → an existing extension")

Run inside `app-api-1` from `/app/apps/api` with `npx tsx` (the container holds the
VoIP.ms master creds in `GlobalVoipMsConfig` and the panel robot creds in
`CONNECT_ROBOT_*` / `CONNECT_BASE_URL`; `ONBOARDING_*` names are UNSET there — `loadPanelConfig()` accepts both).

1. **Pick the stock number from `listSpareDids()`** and ⛔ check it on the PBX
   first: `ombu_tenant_dids` and `ombu_inbound_routes` for that DID must be EMPTY.
   Two of today's 8 spares were NOT clean — `7244198226` (Matamim's retired temp,
   still in `ombu_tenant_dids` 104) and `8452605692` (inii mini's leftover route 239).
2. **`findSubaccountRows(creds, SUB)` → must be 0 rows**, then `createSubAccount`
   **ONCE** (the onboarding param set + `description`), persist the password the
   instant `account` comes back, re-list and assert exactly 1 row. A timeout may
   have landed — never re-send (`NON_IDEMPOTENT_METHODS`).
3. **`setDIDRouting {did, routing: account:<sub>}`** only after re-reading the DID
   and asserting its routing is still `account:344022` (spare). Read back.
4. PBX, Main context: **`createTrunk(s, label, {user, pass, server: newyork1.voip.ms})`**
   — idempotent by label, fires Apply itself. Re-bake doorways after
   (`rebakeConnectRoutesAfterRegen` per connect-mode tenant, the `applyAndRebake` loop).
5. PBX, Main context: **`loadParsedForm(s,"tenants","edit",<id>)`** → collect the
   existing `inbound_numbers[i][did]` rows → assert they equal the snapshot →
   **`saveTenant(s, main, <id>, { inboundNumbers: [...existing, {did, description}] })`**
   → re-load and assert the DID is on the form → `applyChanges` in Main (this is
   what regenerates `default-trunk`) → re-bake. ⛔ Diff `ombu_tenants` +
   `ombu_tenant_settings` for that tenant against the snapshot afterwards — here
   both came back **byte-identical**, so the whole-form re-post moved nothing else.
6. PBX, tenant context: **`extensionId(s, "106")`** (assert the expected panel id)
   → **`createInboundRoute(s, did, extId, label)`** (applies itself) → re-bake.
7. Verify: `pjsip show registrations`, `dialplan show default-trunk | grep <did>`,
   `dialplan show <did>@T<t>_incoming-calls`, doorway counts on T2/T35/T105
   (**1/0, 1/0, 2/0 before and after**), carrier `getRegistrationStatus`.

⛔ The panel ACCEPTED `Trust 9/7/2026` with the slash as a trunk description and
an inbound-route description (the fallback to a hyphen was coded and not needed).
⛔ `register_flag = no` on trunk 182 is the same value the other Trust trunks carry
(44, 67) — not a fault; the registration is live.
⛔ Bash-tool trap re-hit: a heredoc combined with a single-quoted ssh command in one
call failed to parse and wrote NOTHING — write the file with the editor, then scp.

## 3. ⏳ NOT PROVEN

- **No call has been placed to (845) 557-7735.** Everything above is config
  read back from Asterisk and the carrier — not a ring. Ringing ext 106 means
  ringing Miss Spilman's real desk, so the acceptance test was left to Izzy:
  call the number once; it should ring ext 106 (whatever forward 106 carries
  applies from there).
- Texting on this number is not wired (`TenantSmsNumber` unassigned). If it
  should be, assign the row to Trust (ext 106 or shared) per the SMS-activation
  handoff — one PATCH, no carrier write (`sms_enabled` is already `1`).
- Outbound is deliberately untouched: the new trunk is on no outbound route,
  so calls forwarded out by ext 106 leave on Trust's existing routes and CID.

---

# ROUND 2 — the "1730" outbound route (2026-09-08)

Izzy: *"make an outbound route. Use trunk 1000 or 0001, and make the outbound caller
ID be 718-437-1730. Make a prefix of 1730. That would be the code to use for that
outbound route only for Trust bookkeeping."*

## 4. What exists now

| | |
|---|---|
| Outbound route | **179 "Trust 1730"** (Main, tenant_id 1): `cid_name "Trust Bookkeeping"`, `cid_number 7184371730`, **`overwrite_cid = yes`** (forced, like every other prefixed Trust route), ONE trunk: **72 = "0001"** (Telocall) |
| Patterns | the Trust convention (route 44 SpaceArt = prefix `0855`): `845` prepend + prefix `1730` + `nxxxxxx`; prefix `1730` + `nxxnxxxxxx`; `1730` + `1nxxnxxxxxx`; `1730` + `011.` — renders `_1730nxxnxxxxxx` etc., prefix stripped before `Gosub(trk-72,${DNID})` |
| Where it lives | appended as the **second member of ARS-49 "Trust bookkeeping"** (behind route 51, which carries the un-prefixed default patterns). `T18_ARS-all` includes ARS-49; **tenant 18 is ARS-49's only user** (checked `ombu_tenant_settings outbound_profiles` across all tenants). A `1730…` dial resolves in NO other tenant's `T<n>_ARS-all` (13 tenants checked) |
| Tenant regen | **none** — the route + ARS edit render in MAIN only (the A Plus doors lesson); one Apply, doorways T2/T35/T105 still 1/0, 1/0, 2/0 |
| Backup | PBX `/root/trust1730-before-20260908T121546Z/routing-tables.sql` (routes, patterns, members, ars, ars_members, tenant_settings) |
| Scripts | loopcom `/root/trust1730-build.ts` (build), PBX `/root/trust1730-test.sh` (the AMI test below) |

## 5. ✅ PROVEN WITH TWO REAL CALLS, no customer phone rung (08:19–08:20 ET)

AMI Originate `Local/<num>@T18_cos-all/n`, `CallerID: 106`, to Connect
Communications' own (845) 723-1213 (Connect-mode IVR answers; nobody rings):

- **Positive** `17308457231213` → `Outbound Route: Trust 1730` → `Overwrite CID
  (forced)` → `CALLERID(all)="Trust Bookkeeping" <7184371730>` → `Gosub(trk-72,
  8457231213…)` → `Called PJSIP/8457231213@0001` → far end logged
  **`__INCOMING_SOURCE=7184371730`** → answered, hung up after the 4 s Wait.
- **Negative** `8457231213` (plain) → `Outbound Route: Trust Bookkeeping 2` →
  `CALLERID(all)=Trust Bookkeeping <8452441708>` → trunk 72 → far end
  `__INCOMING_SOURCE=8452441708`. **Plain dials are byte-for-byte unchanged.**
- 0 channels left afterwards. ⚠ Those two calls are in Connect Communications'
  inbound history (from 718-437-1730 and 845-244-1708) and in Trust's outbound
  history as ext 106 — test artefacts, not customer calls.

## 6. ⛔ Facts and traps

- ⛔ **718-437-1730 is NOT on the VoIP.ms master account (`invalid_did`) and is on no
  PBX tenant** — Telocall passes it anyway (proven again). Izzy chose it; presenting
  a number the customer does not own is the caller-ID question the doors handoff
  records, and it is his call.
- ⛔ **Trust's whole outbound model is prefix codes**: 1129 Avenue Filing, 0855
  SpaceArt, 0535 Sterlion, 9331 Rollup, 2014 Koznits, 1213 Smooth, 2661 SGE, and now
  **1730**. Route 51 (no prefix) is the default. `ombu_ars_members.sort` is 0 on every
  row — order is insertion order, and here it does not matter: no un-prefixed
  pattern can match a 14/15-digit `1730…` string.
- ⛔ The ARS edit is a whole-form re-post (`loadParsedForm(s,"ars","edit",49)` +
  appended `members[1][…]` rows incl. the `enabled` checkbox as `1`); read back
  `ombu_ars_members` after. The `astmanager` section header in
  `manager__50-ombutel-user.conf` carries a trailing comment — match it with a
  regex, not string equality (cost one failed run).
- ⏳ The route is on no time group and has no PIN. Nothing was changed on ext 106
  itself; any Trust extension can dial `1730 + number` and present 718-437-1730.

## 7. Round 3 (2026-09-08, same morning) — caller ID is "if not provided" now

Izzy: *"In the outbound route, it should overwrite the caller ID when one is not provided."*
Route 179 `overwrite_cid` **`yes` → `if_not_provided`** (the mode Trust's default route 51
already uses): whole-form re-post of the route's own edit form with ONE field changed
(`loadParsedForm("trunk_group","edit",179)` + `applyOverrides({set:{overwrite_cid}})`),
read back, one Apply in Main, re-bake (doorways 1/0, 1/0, 2/0). Patterns and the trunk
list were read back unchanged (4 rows, trunk 72 only). Render is now
`Set(CALLERID(all)=${IF($["X${CALLERID(num)}X"="XX"]?${OUTBOUND_CID}:${CALLERID(all)})})`.

✅ **Re-proven with one positive originate (08:31 ET)**: `sub-construct-cid` blanked the
extension's CID (ext 106 has no `external_cid`), the route filled it, and the far end
logged `__INCOMING_SOURCE=7184371730` again.

⛔ **What "if not provided" means on this PBX**: `sub-construct-cid s-external` blanks
the CID when the extension's `ombu_extensions.external_cid` is EMPTY and leaves it when
set — so an extension carrying its own external caller ID will present THAT on a `1730`
dial, not 718-437-1730. **Today none of Trust's 7 extensions has one** (census 2026-09-08:
all `external_cid NULL`, `dynamic_external_cid no`), so the behaviour is identical to the
forced mode until someone sets one. Script: loopcom `/root/trust1730-cidmode.ts`.
⛔ `FormOption` in `panelForm.ts` is `{ v, t }`, not `{ value }` — a guard reading `.value`
sees `undefined` for every option and refuses a perfectly good form (cost one run).

## 8. Round 4 (2026-09-08 afternoon) — "the prefix is not working": the HANDSET sends `1730` on its own after a pause

Read-only investigation, nothing changed. Izzy: *"They're saying the prefix is not working."*

- ⛔ **The route is fine; the digits never arrive.** `asterisk.cdr` for tenant
  `trust_bookkeepings` shows ext 106's DESK phone (`PJSIP/T18_106`, not the app)
  dialling **`1730` ALONE** at 13:21:45 and 14:21:31 ET (FAILED, 0 s, `ForkCDR`), and
  likewise `7190` and `7735` as lone 4-digit fragments. The PBX received a 4-digit
  call, which matches nothing, so the route never saw a `1730…` string.
- ⛔ **Not a 4-digit dial-now rule** — the same phone sent `8455577735` intact
  (10 digits) at 13:22:02, and in Dec 2025 this same endpoint sent 14-digit prefixed
  dials (`12135622096644`, and `08555622096644` / `20145622096644` / `93315622096644`
  from T18_101) that WORKED. A blanket 4-digit rule would have cut `8455…` too.
- ✅ **THE MECHANISM: the served Yealink config sets
  `account.1.dialplan.digitmap.interdigit_long_timer = 3`** — a 3-second pause while
  typing sends whatever has been entered. Read the code `1730`, pause to read the
  number off the paper, and the phone dials `1730`. `7190`/`7735` are the same shape.
  It is **fleet-wide**: 36 of 39 served Yealink configs carry `= 3` (VitalPBX's Yealink
  templates); every other digitmap key is blank ("keep what the handset has"); no
  config on the PBX sets a digitmap string or a dialnow rule.
- Ext 106's phone: MAC `80:5e:0c:44:5b:30`, provisioning device 50, template 41,
  model 175, config last rendered 2026-05-08 (`805e0c445b30.cfg`). The T43U on
  108.86.0.90 that fetched config on 09-07 is ext **104** (`805e0c78fc7c`), not 106.
  ⛔ Desk phones register with NO user agent recorded in `PbxEndpointRegistrationEvent`.
- **Zero-risk workaround (no change anywhere):** dial all 14 digits without pausing,
  or pre-dial on-hook and press Send. **Fix options, both PBX provisioning writes +
  a `yealink-check-cfg` NOTIFY, Izzy's call:** raise `interdigit_long_timer` (e.g. 8)
  on that one device (per-device override) or on Trust's four phones (template 41 —
  check which other tenants share it first), never fleet-wide by reflex.

## 9. Round 5 (2026-09-08 14:09 ET) — the code works however the phone chops it: `1730` alone gets a SECOND DIAL TONE

Izzy: *"I asked you to create the prefix. When I dial that prefix, that's when that outbound
route should be selected… that prefix is not working."* — a fix, not advice.

**What shipped (PBX dialplan write, tenant 18 only):**
`/etc/asterisk/vitalpbx/extensions__97-connect-trust1730.conf` (repo copy:
`scripts/pbx/extensions__97-connect-trust1730.conf`), picked up by
`extensions.conf`'s `#include vitalpbx/extensions__*.conf`, loaded with `dialplan reload`
(no Apply, no regen, doorways untouched). It appends ONE exact exten to `[T18_cos-all](+)`:
`1730` → `Answer()` → `connect-trust1730-collect`: `Playtones(dial)` + `WaitExten(12)`
(`TIMEOUT(digit)=3`), patterns `_NXXNXXXXXX` / `_1NXXNXXXXXX` / `_NXXXXXX` / `_011.` →
`Goto(T18_cos-all,1730${EXTEN},1)`. So the bare code re-enters the tenant's own outbound
flow with the code prepended and **route 179 carries the call exactly as a 14-digit dial
would** (the route sets `DNID=${EXTEN:4}` itself, so the re-entry strips the prefix).
An exact exten beats the tenant's `_[-+*#0-9a-zA-Z].` catch-all, and a continuous
14-digit dial never touches it (re-verified: `17308457231213@T18_ARS-all` → Trust 1730).

✅ **Proven with a real call**: AMI originate `Local/1730@T18_cos-all/n` (CallerID 106)
with `SendDTMF(wwww8457231213…)` on the originating leg — log: `1730@T18_cos-all` →
Answer → `WaitExten(12)` → digits received → `8457231213@connect-trust1730-collect` →
`Goto(T18_cos-all,17308457231213,1)` → `Outbound Route: Trust 1730` → `DNID=8457231213`
→ `CALLERID(all)=Trust Bookkeeping <7184371730>` → `Called PJSIP/8457231213@0001` →
answered → far end `__INCOMING_SOURCE=7184371730`. 0 channels left. Script:
PBX `/root/trust1730-test2.sh`.

⛔ **Facts for the next person:** the handset side (`interdigit_long_timer = 3`, §8) is
UNCHANGED — the second dial tone makes it irrelevant. A `1730` dial that then goes
silent for 12 s hangs up (`t`); a non-matching entry plays `invalid`. `TIMEOUT(digit)=3`
means a 7-digit local number waits 3 s before going out (7-digit could extend to 10);
10/11-digit numbers go out the instant the last digit lands. Rollback = delete the file
+ `dialplan reload`. ⛔ The doorway file `extensions__60_custom.conf` was deliberately
NOT touched — a parse error in a separate `97-` file cannot take Connect's menus down.
