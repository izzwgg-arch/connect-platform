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
