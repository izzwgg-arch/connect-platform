# Desk Phone Wizard — automatic device identification + maker-cloud providers (2026-09-14)

**Status (round 2, `acb994a3`): RESET-FIRST now governs Prepare Device too (Izzy: "reset every
time you connect the phone"). GDMS card on Admin → Integrations. Deploy state: see §10. No GDMS
credential stored by an agent (Izzy enters it). No phone was touched by an agent.**

Branch `feat/ivr-migration-takeover`. This upgrades the EXISTING Desk Phone Wizard — no second
wizard, no demo screen; the ladder and the setup driver are untouched.

The rule the whole design serves (Izzy's prompt): the wizard asks **"what device did we
discover?"**, never **"what brand did the customer pick?"**. Maker differences live in provider
adapters and capability rules, never in the customer's screens.

---

## 1. The shape

```
office machine (desktop app)                      api                                  maker clouds
  LAN scan + SIP OPTIONS + HTTP banner   ──►  /discovered  ──► evidence on the row
  + Grandstream phone_model API                                   │
  (each tagged with its source)                                   ▼
                                               shared identifyDevice(evidence, cloud state)
                                                 → manufacturer / model / deviceType /
                                                   confidence / capabilities / sources
                                                                  │
                                               /vendor-lookup ────┼──► DeviceProvider registry ──► GDMS (live)
                                               /claim  /prepare   │                              ► Yealink RPS (lookup only)
                                               /scan-label        │                              ► Fanvil / Poly (not connected)
                                                                  ▼
                                               planDevicePreparation → steps run by the provider,
                                               each step audited, reset gated three ways
```

## 2. Identification (shared, pure)

`packages/shared/src/deskPhoneSetup/deviceIdentification.ts` (root-exported).

- **`identifyDevice(evidence, cloudState)`** returns `{valid, manufacturer, model, deviceType,
  deviceTypeLabel, confidence, confidenceScore, mac, macFormatted, ip, serialNumber, firmware,
  capabilities, identificationSources, conflicts, needsIdentifying}`.
- **Manufacturer from the MAC OUI only** (the PBX catalogue's prefixes + the three supplements).
  **Exact model from multi-source evidence**: vendor cloud > PBX provisioning record > device API
  > SIP User-Agent > HTTP banner > barcode label > manual entry. Conflicting sources are reported
  in `conflicts`, never silently resolved.
- **Device types**: `desk_phone, video_phone, ata, door_phone, intercom, conference_phone,
  cordless_base, gateway, paging_device, other_supported_endpoint, unknown` — from the makers' own
  published families (`TYPE_RULES`). ⛔ A model matching nothing is `unknown`, shown honestly.
- **`capabilitiesFor`** → `canClaim, canCloudManage, canFactoryReset, canReboot, canReprovision,
  canPushConfig, canUpdateFirmware, canAssignSip, canCollectDiagnostics, requiresSerialToClaim,
  requiresLocalAuth, supportsZeroTouch`. ⛔ Derived only from what a provider REPORTS it supports —
  nothing is claimed that the maker's API does not provide.
- **`planDevicePreparation`**: registered to us → online; ownership validated first; another
  tenant / another maker account → **conflict**; unknown model → manual; claim (serial required →
  manual if absent); no settings profile → manual BEFORE any reset (never wipe a phone we cannot
  configure, e.g. Panasonic); **then RESET FIRST (round 2): every ticked phone not yet reset in
  this setup (`resetAlreadyDone` = `resetCount > 0`) gets `factory_reset` before reprovision /
  reboot / assign SIP** — unticked → `reset_authorization_required` and nothing at all happens
  (not even the claim); no network reset → `reset_needs_hands_on`, except when a claim is planned
  (the maker can reset only a device it holds: claim, then the plan is decided again);
  reprovision; reboot; assign SIP; verify registration. `lockedByOtherProvider` only changes the
  wording now.
- `parseDeviceLabel(text)` reads MAC / serial / model / maker off a typed or scanned label.
- `provisioningStatusFor` + `describeProvisioningStatus`: Discovered, Identified, Claiming,
  Managed, Preparing, Provisioning, Rebooting, Waiting for device, Registering, Online, Failed,
  Conflict, Manual action required.

## 3. Evidence storage

Migration **`20260914190000_desk_phone_identification`** — six nullable columns on
`DeskPhoneSetupPhone` (`deviceType, serialNumber, identityConfidence, identityEvidence JSONB,
vendorCloudState, vendorCloudCheckedAt`) + index on `macAddress`. Purely additive; verified
**identical** to `prisma migrate diff` from HEAD's schema.

`apps/api/src/deskPhoneSetup/deviceIdentityStore.ts`: sanitises evidence (unknown sources, the
MAC-OUI pseudo-source, a different device's MAC and empty readings are dropped), keeps the newest
reading per source, caps at 16, and turns a row back into evidence (legacy rows read as existing
inventory). ⛔ `mac_oui` is never stored — it is recomputed from the MAC every time.

Wired into the existing routes (`deskPhoneRoutes.ts`): `/discovered` records the device's own
reading (source = the new `identitySource` field: `http_banner | sip_user_agent |
http_device_api | none`); the PBX-record enrichment adds `pbx_provisioning_record` evidence;
`/identify` adds `manual_entry`. A rescan that reads less never erases a model already known.

## 4. Provider interface

`deviceProvider.ts`: every provider implements `detect, lookup, claim, prepare, reset, reboot,
reprovision, assignSip, pushConfig, firmwareUpdate, getStatus, getCapabilities, readiness`. The
wizard and routes never branch on a brand. Failures are `{ok:false, code, message (customer),
staffMessage, retryable, possibleOwnershipConflict?}` from ONE wording table; a raw vendor error
never becomes a customer sentence. `BaseDeviceProvider.prepare` runs only the vendor-cloud steps
(claim / factory_reset / reboot / reprovision), stops on the first failure, and hands every other
step back as `leftForOthers`.

`deviceProviderRegistry.ts`: `providerFor(manufacturer)` (polycom → poly), `allReadiness()` (a
provider that throws reads as not connected).

| Maker | Status | What works |
|---|---|---|
| **Grandstream (GDMS)** | **deepest — live-capable once credentials exist** | lookup, claim (serial required, verified by read-back, idempotent), reboot task, factory-reset task (requires the reset authorisation), status |
| Yealink (RPS) | lookup only, only when the existing RPS adapter is LIVE | tells ours from another account's; redirect-only — no reboot/reset/config (those need YMCS, not integrated) |
| Fanvil (FDPS/FDMS) | not connected | identification from banners/OUI only; every cloud action `not_supported` (FDPS has no self-signup/public API — see the Fanvil handoff) |
| Poly (Lens / ZT) | not connected | identification only; every cloud action `not_supported` (ZT needs an HP Partner contract — see the HP/Poly handoff) |

## 5. GDMS

- `gdmsClient.ts`: OAuth token + signed calls against `*.gdms.cloud` only (`assertGdmsHost`).
  A read refused for its token is retried once; **writes are never retried** — a timeout answers
  `gdms_write_uncertain_check_again` and the row is re-read, never re-written.
- `gdmsCredentials.ts`: region, API ID, secret key, account username + password. Stored encrypted
  via `@connect/security` when `CREDENTIALS_MASTER_KEY` is present; otherwise an env fallback
  (`GDMS_REGION / GDMS_API_ID / GDMS_SECRET_KEY / GDMS_USERNAME / GDMS_PASSWORD`) that ignores
  placeholder values. Descriptions return hints only — never a value.
- `gdmsSimulator.ts` — the realistic mock (known/unknown device, serial required, online/offline,
  claim, another account's device, reboot/reset tasks, timeout, timeout-after-write, 401, token
  401, 429, 500). ⛔ **Test-only**: a guard fails if any non-test module imports it, and
  `GDMS_MODE=test|mock|simulator` makes the real client refuse to run.
- ⛔ **The GDMS request/response field names come from Grandstream's public API docs and have NOT
  been exercised against a real account.** The first live `verify` is the proof.

## 6. Routes (all in `deviceCloudRoutes.ts`, registered from the existing wizard routes)

| Route | Gate |
|---|---|
| `GET /desk-phones/providers` | can set up desk phones; platform names staff-only |
| `GET /desk-phones/runs/:id/phones/:phoneId/identification` | own run (404 otherwise); sources/serial staff-only |
| `POST …/vendor-lookup` | own run; audited |
| `POST …/claim` `{serialNumber?}` | own run; advisory MAC lock; ownership checks; audited (serial tail only) |
| `POST …/scan-label` `{text}` | own run; refuses a label for a different MAC; audited without the serial |
| `POST …/prepare` `{dryRun?}` | own **running** run + can set up; the reset needs the TICK (`/selection`), exactly as the ladder — the separate reset-permission 403 was removed in round 2; the reset is the last step sent in a request, the rest go in `leftForOthers` and run on the next prepare |
| `GET/POST /admin/desk-phones/gdms-credentials` | SUPER_ADMIN; never echoes a value |
| `POST /admin/desk-phones/gdms-credentials/verify` | SUPER_ADMIN; refuses a simulated mode |
| `POST /admin/desk-phones/gdms-credentials/lookup` `{mac}` | SUPER_ADMIN; read-only `findDevice`; returns model/online/firmware/serial tail; audited `GDMS_DEVICE_LOOKUP(_FAILED)` |

**Screen (round 2):** Admin → Integrations (`/admin/integrations`, owner-only) has a
"Grandstream device cloud (GDMS)" card above the company picker — region, API ID, Secret Key,
username, password, Save / Verify / Clear, and "Look up" by MAC. `GdmsCredentialsCard.tsx`.
⛔ There is no "Admin → GDMS" page; round 1's report named one by mistake.

The route-order guard now reads BOTH route files (ownership → permission → body).

## 7. Safety properties (each has a test)

- **Tenant isolation**: another customer's device reads exactly like one that does not exist
  (404 on all five device routes; nothing reaches the maker).
- **Ownership / conflict**: a MAC another Loopcom tenant manages (or is claiming, within 10 min) →
  `device_ownership_conflict`, never re-registered. A maker refusal is flagged
  `possibleOwnershipConflict` and never marked managed. Two tenants claiming the same device at
  once → exactly one wins (Postgres advisory lock `desk-phone-claim:<mac>`).
- **Factory reset** (reset-first, round 2): planned as in §2; the tick is the approval, and
  `decideReset` re-checks it; the one reset is **spent atomically on `resetCount` BEFORE
  the maker is asked** (three racing prepares → one wipe), kept when the task was accepted or may
  have landed, **given back only on a definite refusal**; needs an assigned extension first.
- **Success is never an API call**: an accepted reboot is not "online" — only registration is.
- **Audit** (no secrets): `DESK_PHONE_VENDOR_LOOKUP, DESK_PHONE_CLAIMED, DESK_PHONE_CLAIM_REFUSED,
  DESK_PHONE_LABEL_SCANNED, DESK_PHONE_PREPARE_STEP, DESK_PHONE_RESET_REQUESTED,
  DESK_PHONE_OWNERSHIP_CONFLICT, GDMS_CREDENTIALS_SAVED/CLEARED/VERIFIED/VERIFY_FAILED`.

## 8. Wizard + desktop

- **Portal** (`DeskPhoneWizard.tsx`): the found/match card shows what it looks like **and the
  kind of device**, plus **MAC · IP**; the scan posts `identitySource`; a device we could not name
  gets, beside the make/model pickers, **"Or type or scan what the label says"** → `/scan-label`
  (a handheld barcode scanner types into it like a keyboard). The make/model pickers remain the
  last resort. ⛔ The existing optional "do you know what kind of phone you have?" step is
  unchanged (it only ORDERS the list). ⛔ **These screen additions were not mocked up first** —
  show Izzy before calling them final.
- **Desktop** (`yealink.ts`, `capability.ts`, `sipProbe.ts`): Poly VVX/CCX/Edge/Trio and the rest
  of the Grandstream/Yealink families are named; every fingerprint says its source; a Grandstream
  web page that names no model gets ONE read of the unauthenticated
  `/cgi-bin/api.values.get?request=phone_model` (private-address fenced, no credential, believed
  only for a Grandstream model). ⛔ Only a page that already says Grandstream — asking every
  unknown web server doubled fingerprint traffic and broke the 30/min flood cap (caught by the
  adversarial test, fixed before commit). ⛔ **Rides the next desktop installer**; the portal
  degrades cleanly without it (no source → server records a generic banner).

## 9. Tests run (all green except the documented pre-existing ones)

```bash
cd packages/shared && node --import tsx --test src/deskPhoneSetup/deviceIdentification.test.ts   # 32/32
cd packages/shared && npx tsc --noEmit -p tsconfig.json                                         # 0
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/deviceProviders.test.ts     # 33/33
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/deviceCloudRoutes.test.ts   # 27/27
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/deskPhoneSetup/*.test.ts"                # 242: 241 pass, 1 skipped (real-Postgres test)
cd apps/api && npx tsc --noEmit -p tsconfig.json                                                # 84 = baseline, 0 in deskPhoneSetup
cd apps/desktop && node --import tsx --test "src/phoneSetup/*.test.ts"                          # 152/152
cd apps/desktop && npx tsc -p tsconfig.json --noEmit                                            # 0
cd apps/portal && npx tsx --test components/deskPhones/*.test.ts lib/deskPhoneWizard.test.ts lib/nativeSelectSweep.test.ts
#   113: 112 pass; the 1 failure is lib/nativeSelectSweep → OrdersDesk.tsx:563 (pre-existing, not this work)
cd apps/portal && npx tsc -p tsconfig.json --noEmit                                             # 0
# prisma migrate diff HEAD schema → new schema == the migration SQL, byte for byte in content
# PORTAL_GUARD_ROOT=<HEAD export> wizardDeviceIdentity.test.ts → 3 of 5 FAIL at HEAD (2 are regression guards)
```

Coverage in those suites: signature vector, host allowlist, runtime-mock refusal, simulator import
guard, every injected failure (timeout/401/429/500/token/timeout-after-write), claim idempotency and
read-back, other-account refusal, reboot/reset task gating, readiness matrix for all four makers,
Yealink RPS live fake, prepare step ordering / refusal / stop-on-failure, credentials validation and
no-leak, identity-store sanitising, tenant isolation (404), concurrent cross-tenant claims,
stale/fresh claim locks, label for a different device, dry-run writes nothing, reset authorisation /
single spend / racing prepares / refusal gives the reset back / unticked → 409, staff-only
credential screens, read-only lookup never adds or tasks. Round 2 adds: reset-first ordering,
second prepare restarts without a second reset, unticked phone untouched, SWEEP over
`resetAlreadyDone` (reset only ticked + not yet reset + profile exists + before every
settings step).

## 10. NOT PROVEN — and what enabling needs

- ✅ **api DEPLOYED + container-verified 2026-09-14 19:13Z at `acb994a3`** (deploy-direct, blue/green):
  `app-api-1` `.build-commit` = `acb994a32b1a…`, 0 restarts, `/health` 200; the container runs from
  source and carries the lookup route + `resetAlreadyDone`; migration
  `20260914190000_desk_phone_identification` finished 19:08:35Z and all six columns exist on
  `DeskPhoneSetupPhone`. Level-50 log lines after the deploy were only the standing TURN-probe /
  relay-usage monitors (unrelated). `CREDENTIALS_MASTER_KEY` is set, so a GDMS save will not 503.
  ⛔ First attempt failed harmlessly at git-sync on a mistyped sha (`acb994a3d`) — nothing changed.
- ✅ **Desktop `0.1.17-rc.14` built from a clean `git archive f8e11424` export and INSTALLED on Izzy's
  PC (`/S`, exit 0).** tsc 0; desktop phoneSetup 152/152; `Connect-Setup-0.1.17-rc.14.exe`
  100,525,567 bytes, sha256 `5a652daf…fe13`; verify-built-icon OK. Asar checked before install
  (`aaf9b3b6…d9f4`): version rc.14, all 8 electron-updater deps packed, Grandstream `phone_model`
  read + Poly families in `dist/phoneSetup/yealink.js`. Installed asar identical, registry rc.14,
  relaunched (the silent install closes the app and does NOT reopen it), log banner rc.14, 0 error
  lines, updater refuses the rc.10 feed as a downgrade, PnP on udp/5060+5080, `arm_pnp macs=2 ok`.
  ⛔ **NOT published — the fleet feed stays at rc.10.**
- ✅ **portal DEPLOYED + container-verified 2026-09-14 19:22Z at `acb994a3`**: `app-portal-1`
  `.build-commit` = `acb994a32b1a…`, 0 restarts, 0 error lines; `/admin/integrations` 200 on both
  hostnames; shipped chunks carry "Grandstream device cloud (GDMS)" (2), the `gdms-credentials`
  calls (1) and "Or type or scan what the label says" (2). ⏳ Nobody has opened either screen in a
  browser yet; an open tab / desktop window keeps the old bundle until reloaded.
- ✅ **LIVE GDMS HANDSHAKE PROVEN 2026-09-14 20:07Z.** Izzy saved the account on the card himself
  (20:05, region us, API ID …5002; agent never saw a value). Verify → HTTP 200 in 1.4 s,
  `GDMS_CREDENTIALS_VERIFIED {organizations: 1}`. Look up `C0:74:AD:8C:60:5F` → HTTP 200 in 1.3 s,
  `GDMS_DEVICE_LOOKUP {found: false}` — and that is TRUE: the GDMS UC dashboard shows **Total
  Devices 0** (the GXP2170 was used for account verification, never added as a device). So token,
  signature and the list call are right; the device-record field names are still unproven until
  a device exists in GDMS. ⛔ Adding it (claim) is a write — only on Izzy's word.
  (`.env.gdms` at the repo root is unused — the card save is the live source.)
- (history) **No GDMS credential was stored and no live GDMS call had been made before 20:05Z** — so the live-safe
  validation the prompt asks for (read-only lookup against the real account) has not run. Enable:
  confirm `CREDENTIALS_MASTER_KEY` is set in `app-api-1` (else the save answers 503), save the API ID
  + secret + the GDMS login on **Admin → Integrations → Grandstream device cloud** (⛔ never through
  chat), press **Verify**, then **Look up** Izzy's test GXP2170 (`C0:74:AD:8C:60:5F`). ⛔ Claim,
  reboot and reset only on a designated test device, by Izzy.
- **RESOLVED (round 2):** Izzy chose reset-first for everything ("reset every time you connect the
  phone"). `/prepare` now matches the ladder: tick = consent, reset first, once per setup.
- Yealink RPS still has no credentials (tickets pending); Fanvil and Poly have no API access at all.
- The new card line and label box have not been seen in a browser.

## 10b. Round 3 (`7e54716a`) — why ticking a GXP2170 did nothing, and the per-brand fix

**Diagnosed live 2026-09-14 20:13Z (Landau Home run `cmu0wf85m05u3s9135s7lmzaw`).** Izzy ticked
the GXP2170 at .171; the ladder said `reset_over_lan` (proven by replaying `nextEscalation`), the
driver's `!canHttp` gate skipped the reset for a Grandstream and fell to `set_provisioning`, which
for a brand with no HTTP executor only ARMS the PnP listener and shows "unplug it and plug it
back in". Nobody power-cycled it: 13 advances every 4 s, no reset, no write, cancelled 20:14.
**Nothing in the wizard called the GDMS routes** (`/prepare`, `/claim`, `/vendor-lookup` had no
caller). The second GXP (.172, `c074ad8c605f`) never answered the 20:12 scan (its only evidence is
`existing_inventory`) and is registered nowhere — powered off or on another address.
⛔ The .171 GXP is still REGISTERED as **Create A Box T7_106** (contact on Izzy's LAN); its PBX
record was rehomed to Landau Home ext 101 at 20:13 (`decideRehome` allowed it on the same-LAN proof).

**The fix:**
- **`packages/shared/src/deskPhoneSetup/deviceMechanisms.ts` — `deviceMechanismsFor(vendor, readiness)`**,
  ONE answer per brand: reset `vendor_cloud | lan_http | not_available`, restart
  `vendor_cloud | lan_http | power_cycle | not_available`, settings `pnp | lan_http | hand_configured |
  not_available`. Built only from shipped executors, the PnP catalogue and a cloud's readiness here
  (configured, not redirect-only, action implemented, same brand). Never clears/restarts a phone
  nothing can then configure. Panasonic = hand_configured, never cleared. SWEEP test over every
  catalogue brand × every cloud shape; without a cloud it equals the old gates exactly.
- **`/advance`** (deskPhoneRoutes): the pure ladder is untouched; the route adds `via: "vendor_cloud"`
  (+ the tenant folder URL) when `decision.action` is `reset_over_lan`/`set_provisioning` and the
  brand's mechanism is the cloud. Registry hoisted to the top of `registerDeskPhoneSetupRoutes`
  (shared with the cloud routes); readiness cached 30 s; a readiness failure = no cloud.
- **Driver** (`setupDriver.ts`): `via vendor_cloud` → arm the PnP listener FIRST (refused listener =
  no clear), then `POST /prepare` (claim → factory reset, spent atomically server-side, so no
  `/reset-sent`); later `set_provisioning via vendor_cloud` → listen, then a GDMS restart through
  `/prepare`, at most `PROVISIONING_REBOOT_ATTEMPTS` (2), `CLOUD_RESTART_WAIT_MS` (3 min) apart. One
  cloud ask per phone per `CLOUD_ASK_INTERVAL_MS` (30 s). `serial_required` → NeedsPerson `serial`.
  A non-retryable refusal, a conflict/unknown model, or "I can't find it" sets `cloudUnavailable`
  and the phone takes the exact pre-cloud path. The office machine never wipes or restarts a cloud brand.
- **Wizard**: "needs its serial number" screen (posts `S/N: <typed>` through the existing
  `/scan-label`, which refuses another phone's label); one read-only `/vendor-lookup` per found phone
  whose maker is known but model is not.
- **No desktop change**: `set_provisioning {reboot:false}` already exists in rc.14.

**✅ DEPLOYED + container-verified 2026-09-14:** api 20:55Z and portal ~21:01Z, both `7e54716a`
(waited for Izzy's own Deploy Center portal job `f2460c4f` to finish — the queue refused while it ran;
no break-glass). api: 0 restarts, `/health` 200, `deviceMechanismsFor` in the running source.
portal: 0 restarts, 0 error lines, `/settings/desk-phones` 200 on both hostnames, the shipped chunks
carry "needs its serial number" and "phone maker’s cloud to clear". Shipped alongside (other
sessions, already pushed): `f2460c4f` dashboard polish, `770de892` email sender name.

**⏳ NOT PROVEN (needs Izzy + a real phone):** GDMS holds 0 devices, so the first real run will ask
for the GXP2170's serial (on its sticker) and CLAIM it into Loopcom's GDMS — a write. Unverified:
the GDMS device-record field names; whether a GDMS factory reset keeps the device in the account and
back online to GDMS; whether the reset GXP asks over PnP on its boot. Reset takes .171 off Create A Box 106.

## 10c. Round 4 (`c7f5459c`) — reset a Grandstream over the LAN with the password, no serial

**Why.** GDMS reset needs the device ADDED to the account first, which needs the serial number, and
an existing customer's phone won't give its serial over the network (proven 2026-09-14 by reading
Izzy's GXP2170 at .171 unauthenticated: `phone_model`, MAC and vendor answer; `serial_number`/`sn`/`P89`
all come back empty; the sticker is the only source). Izzy: an existing customer "will have to go to the
physical phone … there is no way to get the serial number." So the LAN reset — type the admin password
once into the wizard's existing password box — now PREFERS over the serial-based cloud reset.

**The build:**
- **`apps/desktop/src/phoneSetup/grandstream.ts`** (NEW): session executor. `POST /cgi-bin/dologin`
  (`username=admin&password=…` in the body, never the URL) → `{sid, cookie}`; `POST /cgi-bin/api-sys_operation`
  `request=REBOOT|RESET&sid=…`. Address-fenced (`canonicalPrivateIpv4`), HTTP→HTTPS scheme fallback, never
  retried, **no default password** (Grandstream's is random per unit). ⛔ SETTINGS ARE NOT WRITTEN HERE —
  a reset Grandstream asks over SIP PnP, which the resident already answers, so there is no HTTP config
  write and the P237/P212 trap ([[grandstream-p237-is-not-a-url]]) is not touched.
- **`capability.ts`**: `reboot` / `factory_reset` / `set_provisioning` restart / `test_credentials` branch on
  `vendor`. Grandstream has no autop and no default-password probe (returns "no_default", so the ladder goes
  straight to the password step rather than spending a login toward the phone's lockout).
- **shared**: `VENDORS_WITH_A_SHIPPED_HTTP_EXECUTOR` and new `VENDORS_WITH_A_LOCAL_RESET_EXECUTOR` /
  `vendorSupportsLocalReset` both include grandstream; **`deviceMechanismsFor` prefers `lan_http` reset over
  `vendor_cloud` whenever a local reset executor exists** (password beats serial); `capabilitiesFor` grants
  the local Grandstream reset (`canFactoryReset` paths gain `local_http`).
- **driver**: passes `vendor` to the desktop for the brand-specific calls. A Grandstream now takes the
  `reset_over_lan` local path (login → RESET), not the GDMS path. GDMS reset/restart stay wired for a future
  brand-in-account case; GDMS lookup still runs read-only for model discovery.
- **desktop `0.1.17-rc.15`** — BUILT from a clean export of `c7f5459c` and INSTALLED on Izzy's PC 2026-09-14
  (exe 100,530,512 bytes sha256 `bb669f64…`; asar `91fc4013…` identical build vs installed; registry rc.15;
  log banner rc.15, 0 errors, PnP armed; `grandstream.js` carries `dologin`+`api-sys_operation`, `capability.js`
  carries `isGrandstream`). ⛔ NOT published — the fleet feed stays rc.10 (the updater refused it as a downgrade).

**Tests:** shared 708/708 (deviceMechanisms flipped to LAN-first; deviceIdentification capabilities; the
invariant "only Yealink over HTTP" updated to Yealink+Grandstream); api deviceCloudRoutes 33/33 (Grandstream
ticked → `reset_over_lan`, no `via`); portal setupDriver 44/44 (a Grandstream is cleared over the LAN with the
password; brands with no executor still take the hand-off); desktop 164/164 incl. new `grandstreamAdapter.test.ts`
12/12; every tsc 0.

**❌ rc.15's LOGIN SHAPE WAS WRONG — corrected in round 5 below. The "documented" forum/API shape
(plain `password=` to `dologin`) is NOT what a GXP2170 on 1.0.11.x accepts.** Izzy ran it 21:57Z with the
CORRECT password and the phone refused four times (`factory_reset … -> refused:locked` ×4 in 40s). This is the
exact failure [[adapter-proven-means-a-real-handset]] exists to catch: a shape read from documentation and
community scripts, shipped without a real handset ever accepting it.

## 10d. Round 5 (`rc.16`) — the REAL Grandstream login, read off the phone's own web app

**How it was found (all read-only, no password sent by an agent).** The phone's web UI is a GWT app that also
loads `sjcl.js`. Fetching `/webapp/webapp.nocache.js` → permutation `21412022F087F210A8C0F7CFF55D7906.cache.js`
and reading its decompiled source gives the login verbatim:
- `LDb()` → `POST /cgi-bin/access` body `access=<hex(sha256(username))>` → `{"response":"success","body":"<token>"}`
- `ODb()` → `POST /cgi-bin/dologin` body `username=<plain>&password=<Oxb(password + token)>`
- `Oxb(a) = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(a))` — i.e. **hex(sha256(password + token))**
- then `POST /cgi-bin/api-sys_operation` body `request=REBOOT|RESET&sid=<sid>`

**⛔⛔ AND EVERY ONE OF THOSE CGI PATHS NEEDS A `Referer` HEADER.** Proven live on the handset: the identical
`POST /cgi-bin/access` answered **403 Forbidden** bare and **200 with a token** once `Referer: http://<ip>/`
(+ `Content-Type: application/x-www-form-urlencoded`) was added. rc.15 sent none of this.

**Fixed in `grandstream.ts`:** two-step login with the token handshake, `hex(sha256(password+token))` (the plain
password never reaches the wire, pinned by a test), `Referer` on every request, private-IP fence unchanged, and
"a token we cannot read" reports `refused` — NEVER `locked` — so an unreadable shape can never be mistaken for a
wrong password. **`capability.ts` gained `MAX_LOGIN_FAILURES_PER_PHONE = 3`**: a phone that has refused us three
times is not asked again this session, because Grandstream locks a phone's web UI out on repeated bad logins and
rc.15 spent four attempts in forty seconds. `classifyResetAnswer` maps that refusal to "nothing was sent", so it
can never be recorded as a wipe.

**Server state after the failed run: CLEAN.** Every phone row reads `resetCount 0, attempts 0, state IDENTIFIED` —
nothing was wiped, and the one reset per setup is still unspent.

**⏳ STILL UNPROVEN:** no Grandstream has yet been logged into or reset by this code. The handshake half IS proven
live (the token came back 200); the `dologin` half needs Izzy's password, which only he types. Failure stays safe:
a refused login falls back to the PnP power-cycle.

## 10e. Round 6 — no password? then ask for the SERIAL (the second door), and rc.16 is installed

**Izzy, 2026-09-14: "If the user doesn't have the password, it should ask for the serial number."**
Before this, "I don't know it" ended the phone at the ladder's hands-on halt, even though a second key
existed. The two keys to a Grandstream are the **admin password** (office-network reset) and the
**serial number** (add it to GDMS, then reset through the cloud). Now the wizard offers both, in that order.

- **shared** `DeviceMechanisms` gains **`resetFallback: "vendor_cloud" | "none"`** — the second door, set only
  when this deployment's cloud really implements a wipe for that brand and it is not already the primary.
  Sweep-tested: the fallback is never the same door as the primary and never claimed without a real cloud wipe.
- **`/advance`** takes a new observed flag `makerCloudUnavailable` and, when `passwordUnavailable` is true, the
  brand has a `resetFallback`, the one reset is unspent, the phone is ticked and not already registered,
  converts the halt into `reset_over_lan` + `via: "vendor_cloud"` — which runs `/prepare`, comes back
  `serial_required`, and shows the serial screen built in round 3.
- **driver** reports `makerCloudUnavailable` (set by "I can't find it" or a refusal that will not change), so when
  BOTH doors are shut the ladder's honest hands-on halt stands instead of asking for the serial again.
- ⛔ With no cloud configured there is no false promise: no password still ends at hands-on (tested).

**Desktop `0.1.17-rc.16` BUILT from a clean export of `3aec620e` and INSTALLED on Izzy's PC.** exe
100,532,785 bytes sha256 `3BBDBAB9…6C70`; installed asar `D1913541…E81D` byte-identical to the build; registry
rc.16; log banner rc.16 with 0 errors; PnP armed; 167/167 desktop tests; tsc 0. The shipped
`dist/phoneSetup/grandstream.js` carries `cgi-bin/access` ×3, `Referer` ×5, `sha256` ×6, and `capability.js`
carries the login cap. ⛔ NOT published — the feed still reads rc.10 (the updater refused it as a downgrade).

## 10f. Round 7 — the password question is DELETED from the customer's path; the serial is asked once, on the extension screen

**Izzy, 2026-09-14: "I don't want it to ask for the password. Once it finds the phone and the customer
selects the phone, it goes to where they select the extension. Where they select the extension, they
should also be prompted to enter the serial number."** Round 6 made the serial the *second* key. This
round makes it the *first*, and moves the asking to a screen the person is already on.

- **shared** `deviceMechanismsFor` — precedence **INVERTED ON PURPOSE** vs round 4: a brand with a
  connected, wiping cloud is `reset:"vendor_cloud"` with `resetFallback:"lan_http"` (the password).
  `resetFallback` widened to `"lan_http" | "vendor_cloud" | "none"`. ⛔ `usesCloud` no longer consults
  the fallback — today it can only be the LAN door, so a cloud named through it cannot exist; the
  comment there says to add it back if a brand ever gains a cloud *fallback*.
  Sweep invariants rewritten: the fallback is never the primary's own door, never offered with no
  primary, and `lan_http` only for a brand with a shipped local reset executor.
- **`/advance`** now converts **all THREE shapes** of the ladder's password question into the cloud
  route: `try_default_credentials`, `ask_for_password`, **and the `halt`** it returns when
  `passwordUnavailable` (`decision.action === "halt" && condition.locked && condition.passwordUnavailable`).
  ⛔⛔ The halt is the one that is easy to miss: without it, a customer who once said "I don't have the
  password" is sent to hands-on while the cloud route sits open. Gated on: one reset unspent, ticked
  with an approval, not already registered to us, and `makerCloudUnavailable !== true`.
- **`customerPhoneView`** gained **`serialOnFile`**; **`DeskPhoneWizard`** shows a serial box + the
  sticker drawing on the **match step** for a ticked phone when it is false, submitting through the
  existing `scanLabel` route (so a label belonging to a different MAC is still refused).
  ⛔ `supplySerial` now re-reads the run — without that the serial IS saved and the box just sits
  there, which reads as "it didn't work" and invites a second entry.
- ⛔ The password path is **not deleted from the code** — it is the fallback, and a Grandstream with
  no configured cloud still uses it exactly as rc.16 shipped it (tested).

⏳ **NOT BUILT (parts 2 and 3 of Izzy's flow):** upload a photo of the label; text the photo to the
business number after being asked *which number it will come from*, then read that chat once and
refuse an unreadable picture on OCR confidence. Both are inert until `CRM_OCR_ENABLED=true` on the
api — **Izzy's decision** (Tesseract engine and the language-data host are already verified reachable,
and inbound MMS already lands tenant-resolved as chat attachments).

## 10g. Round 8 — the label as a PHOTO: uploaded, or texted to the business number

**Izzy, 2026-09-14:** *"upload a photo of the back of the phone / text the photos through our
business number … the system should check if it's a clear picture. If not, tell them to send a clear
picture if it's not readable"* and *"we don't need an OCR that would constantly check. Just when they
send a text message, the system will check the chat and find the message. You can also make the
system prompt them which number they're going to send it from, so the system knows what to look for."*

- ⛔⛔ **ONE GATE, THREE DOORS.** `recordLabel()` in `deviceCloudRoutes.ts` is now the only place a
  label is judged and written; `scan-label` was refactored onto it rather than copied. The doors are
  typed/scanned, uploaded photo, texted photo. **Never add a fourth by copying the third** — a second
  copy is how one door comes to accept what another refuses, which here means a serial silently
  attached to the wrong handset.
- **Routes** (all run-scoped, `ownRun` first — proven by `deskPhoneRouteOrder.test.ts`):
  `POST …/phones/:phoneId/label-photo` (multipart `file`, ≤10 MB, OCR in memory, **nothing stored,
  nothing logged**); `POST …/label-photo/expect` `{fromNumber}` → normalises via
  `normalizeUsCanadaToE164`, refuses when no tenant number is `mmsCapable`, stores
  `labelPhotoFromE164` + `labelPhotoAskedAt`, answers with the number to text; `POST …/label-photo/check`
  → one bounded lookup, OCR, same gate, clears the expectation **only** on an accepted label.
- ⛔ **The clarity rule (`MIN_LABEL_PHOTO_CONFIDENCE = 55`)**: accept a photo only when OCR's own
  confidence clears the bar **or** the MAC on the sticker matches this phone. A serial we cannot
  vouch for is worse than none — it fails at GDMS minutes later, as an error about a number the
  customer never typed.
- ⛔ **The accusation rule**: a MAC mismatch read *below* the bar answers `photo_unreadable`, not
  `label_for_different_device`. 8/B, 0/D, 5/S and 1/I are what OCR mangles first on a soft photo.
- ⛔ `labelTextFromPhoto()` exists because `parseDeviceLabel` reads only the first 600 characters —
  fine for a typed line, NOT for a photo of an underside carrying regulatory small print. Whitespace
  is collapsed and the window is centred on the S/N / MAC marker, or the serial is truncated away
  and a perfectly good photo is reported unreadable.
- ⛔ Evidence source stays **`barcode_label`** for photos: a photograph of the label IS the label, and
  a new source would mean touching the shared identification union and its confidence ordering
  across every brand to record something only the audit needs (`metadata.via` carries it instead).
- **Test harness changes worth knowing:** the fake db's `matches()` now really compares `gte/gt/lte/lt`
  (it used to wave every object filter through, which would have passed the "an older photo is never
  used" test while the real query did the opposite); `makeApp` registers `@fastify/multipart` because
  `server.ts` does; the OCR engine is **faked on purpose** — what is under test is our judgement of a
  picture, not Tesseract's.
- **A real defect the tests caught:** `expect` validated `fromNumber` with `z.string().min(7)`, so a
  short typo ("nope") answered a bare `invalid_request` with no sentence and the browser showed its
  fallback wording. The length bound is now `min(1)` and the normaliser is the single judge.

⏳ **NOT PROVEN:** no real photograph has ever been OCR'd here, and nobody has uploaded or texted one.
✅ **FLIPPED 2026-09-15 — both doors are LIVE.** Izzy: photo reading on for every desk-phone-setup
customer. `CRM_OCR_ENABLED=true` in `.env.platform` (backup `.env.platform.bak-20260915-ocr`),
shipped via commit `5adb347a` — env-only changes have no deploy path (a pinned same-commit redeploy
skips `no_changes`), so the flip rode a real `apps/api/.env.example` correction. Container-verified
same day: value read from `app-api-1`, 0 restarts, health 200. ⛔ Shared switch: CRM image-document
OCR (Phase 5B) is now ON platform-wide too. ⏳ Still unproven: no real photograph OCR'd — the
wizard's number-prompt appeared, but no upload or texted photo has been judged yet.
With it off they answer `photo_reading_off` — "type the serial number instead" — and store nothing.

## 10h. Round 9 (2026-09-15) — the FIRST LIVE GDMS WRITE, and what it proved wrong (`3040f2bc`)

Izzy's live run (Landau Home, GXP2170 `C0:74:AD:8C:65:4E` at 192.168.6.171): he typed serial
`20ZE115N308C605F`, the card said *"Grandstream didn't confirm the device was added"* and the
wizard spun on "Finding" until the 10-minute watchdog offered Keep trying / Cancel.

- ⛔⛔ **`v1.0.0/device/add` is a BATCH endpoint.** Captured live: envelope `retCode 0` with
  `data = {"total":1,"success":0,"failure":1,"errorDeviceList":[{"orgId":null,"deviceName":null,
  "siteId":675285,"mac":"C074AD8C654E","errorMsg":"30010","sn":"20ZE115N308C605F"}]}` — and the
  account's unfiltered device list read total 0 before AND after. `addDevice` read only the
  envelope, so the refusal became success → read-back miss → `claim_not_verified` (retryable) →
  the driver re-claimed forever. **Fixed:** a per-item failure now throws `GdmsRejection` →
  `gdms_request_rejected`, non-retryable; the simulator models the proven shape through a new
  `owner: "unowned"` factory-registry state; the new test in `deviceProviders.test.ts` fails
  against the pre-fix client (replayed, fail 1) and passes with it.
- ⛔ **The serial itself was the OTHER unit's.** Grandstream serials embed the device's own MAC
  tail; `…308C605F` is the `C0:74:AD:8C:60:5F` unit (the round-2 GDMS-card test MAC), not this
  phone (`…8C654E`). GDMS validates the pair — errorMsg 30010 (meaning not documented; we surface
  the generic refusal wording, which already names the serial-mismatch case, and never the code).
- ⛔ **A stuck run keeps its wrong serial** — `serialOnFile` stays true so the serial box does not
  return mid-run; cancel + rerun creates fresh run rows and asks again. Live-verified field shapes:
  device/list filter `mac` works (formatted, colons); site/list rows are `{id, siteName, isDefault,
  description, children}`; errorDeviceList macs come back UPPERCASE WITHOUT colons.
- **The probe recipe** (read-only, reusable): decrypt AgentSecret `gdms_credentials` inside
  `app-api-1` (AES-256-GCM under `CREDENTIALS_MASTER_KEY`; row via `connectcomms-postgres` psql),
  OAuth password grant sends `sha256(md5(password))`, every API call is `POST
  /oapi/v1.0.0/<api>?access_token&signature&timestamp` with the canonical-string sha256 signature
  from `gdmsSignature`. Never print the credentials; print only GDMS's answers.
- ⏳ **Still not proven:** no successful GDMS claim (needs the RIGHT serial off THIS phone's
  sticker), no cloud reset, no photo OCR.

## 10i. Round 10 (2026-09-15) — the wizard owns the phone; the neighborhood stops being imported (`7e427c28`)

Izzy's live run, continued. After the right serial went in, the claim VERIFIED and the cloud reset
ran — and the run halted on `held_by_another_account`: the MAC was still recorded under Create A
Box (provisioning.devices row 23, bound to T7_102, whose real 102 is live on two other contacts).
Izzy released it by hand (his explicit instruction; backup
`pbx:/root/landau-gxp-record-release-20260915T100155Z/` — rows + the per-MAC cfg xml), then ruled:
*"the desktop wizard gets priority, and anything else is deleted. That phone belongs to the wizard."*

- **`decideRehome` policy change (shared):** live registrations by OTHER devices no longer refuse —
  releasing a MAC record does not touch a registration. Kept refusals: unreadable registration
  state; missing presence pair (discoveredIp + requesterIp); the forger shape — this handset's own
  LAN address registered from a DIFFERENT public address ("a claim from elsewhere never takes it").
  `RehomeDecision.releasedOverLive` names what stayed live; auditRehome records every move.
  ⛔ An OPEN item: a halt that still happens is silent — Izzy wants a notify; only the audit exists.
- **Driver `rediscover` (portal setupDriver):** posts only MACs already in the run. It posted raw
  hosts and imported 87 home devices as phones (the 2026-08 pre-filter bug through a second door).
  The ghosts were cleaned by marking them skipped in the run — note the wizard's progress screen
  LISTS skipped rows in its count ("0 of 88"), a cosmetic oddity left alone.
- **GDMS field truths (first real rows ever):** device/list row = {orgId, deviceName, deviceType
  (model!), mac (colons), sn, publicIp, privateip, firmwareVersion, lastTime, status (NUMBER; 1 =
  online, proven), accountStatus, dnd, siteId, siteName, isSynchronized, …}. site/list rows carry
  {id, siteName, isDefault, description, children}. `parseGdmsDevice` now maps numeric 1 → online;
  other numbers stay null on purpose (offline gates cloud tasks; nobody has seen a real offline row).
- **Ops notes from the night:** deploy-direct refuses while another session's queue job builds
  ("HEAVY JOB ALREADY RUNNING") — retry, do not force; a portal deploy pops "Connect was updated —
  Reload" in the desktop and the reload KILLS the wizard driver (the run resumes via POST /runs,
  one-live-run-per-customer); closing the Loopcom window stops the driver too (audit:
  DESK_PHONE_OFFICE_STOPPED) — both looked like "stuck on restart" until read from the audits.

## 10j. Round 11 (2026-09-15) — the Grandstream LAST MILE is fragile; the durable path is GDMS redirection, NOT BUILT

Izzy: *"proof that every single Grandstream phone will do this flawlessly … rock-solid, for the long
term, sustainable for years."* Chasing that on his factory-reset GXP2170 exposed that the wizard's
config-DELIVERY last mile is running on two mechanisms that are not rock-solid — and it could not be
proven fleet-wide, so it is NOT claimed. Findings, all live:

- **Local HTTP config push silently no-ops on a GDMS-claimed phone.** The GWT web API works
  (`cgi-bin/access` → `dologin` with sha256(md5(pw)) then sha256(pw+token) → `config_update?sid=` with
  JSON `{"alias":{},"pvalue":{"237":"…","212":"2"}}`; read via `config_get?pvalues=237,212&sid=`;
  the metaconfig alias map is `cgi-bin/metaconfig_get`). Auth with admin/admin succeeded, but the
  write returns `{}` and read-back keeps the factory default `fm.grandstream.com/gs`. The phone is
  GDMS-claimed with `provisioning.3cxAutoProvision=1`; GDMS owns provisioning direction. ⛔ Do NOT
  build on these reverse-engineered cgi endpoints — it is the P237-URL trap in a new form, breaks per
  firmware, the opposite of sustainable.
- **PnP multicast never reached the desktop resident.** `resident: told`/`resident: heard` = 0 across
  the ENTIRE day; every `set_provisioning` logged `delivered=false`, and a fresh GDMS/self reboot
  produced no delivery either. Multicast PnP needs office-PC + phone on one L2 segment, multicast
  unfiltered — environment-dependent, not fleet-durable.
- **api-change_default_password** authenticates and returns success but the phone's own strength rule
  silently rejects a weak/short new password (default P2 on the PBX template is 4 chars) — the phone
  stays on admin/admin. Nothing was left changed on the handset; it is still factory + GDMS-claimed.

✅ **THE DURABLE ANSWER — GDMS PROVISIONING REDIRECTION (build item).** Factory P237 defaults to
`fm.grandstream.com/gs` = GDMS's redirect endpoint. Configuring GDMS to hand claimed devices our
`209.145.60.79/phoneprov/<hash>` (HTTPS) means any factory-reset Grandstream with only outbound
internet self-provisions — no LAN, no multicast, no password. `gdmsClient.ts` has lookup/claim/reboot/
reset/status but NOT the template/redirect push; that is the gap. Fleet proof = build the redirect
push, wire it into the claim step, then a repeatable factory-reset→register test (N times,
source-guarded). Memory: [[grandstream-zero-touch-needs-gdms-redirect-not-lan]].

⏳ **HONEST STATE:** the desk phone did NOT register (the live `T21_101_1` contact is the WebRTC app,
not the handset — the `_1` suffix). No fleet-wide proof exists or should be claimed until the redirect
push is built. The session's OTHER fixes (batch-result read, serial-mismatch message, OCR rotation,
rehome wizard-priority, rediscover filter, GDMS numeric status) ARE deployed and real.

## 10k. Round 12 (2026-09-15) — GDMS cloud config push PROVEN; the real blocker is a moved-phone template with a VPN SIP server

Izzy: *"proof that every single Grandstream phone will do this flawlessly … for years."* Built toward
it by finding + verifying the DURABLE delivery mechanism, and in doing so uncovered the config bug
that actually stops registration. Honest state: NO phone has registered yet; the mechanism is proven
and the blocker is precisely diagnosed.

✅ **GDMS `device/config/xml` push works end to end (durable, LAN-independent, sustainable).**
Authoritative spec: the doc SPA at doc.grandstream.dev is backed by a public `api_data.json`; the
full endpoint catalog + field shapes are in memory [[gdms-openapi-provisioning-spec]]. The push:
`POST /oapi/v1.0.0/device/config/xml`, **multipart/form-data**, `mac` text field + `xml` FILE part,
orgId optional. ⛔ Signature is the FORM method (NOT the JSON canonical the client uses today): map
{access_token,client_id,client_secret,timestamp,mac,xml=md5(fileBytes)}, sort keys ascending, join
key=value with &, `sha256("&"+sorted+"&")`. PROVEN LIVE on C0:74:AD:8C:60:5F: retCode 0,
`isSynchronized:1`, and the phone PULLED + APPLIED the config over the cloud (its ping + web UI went
dark exactly as the pushed config's hardening dictates). The native XML must be gs_provision format,
which our phoneprov already renders. NOT YET productionized in gdmsClient (contract is proven).

⛔⛔ **THE REAL BLOCKER — the moved phone's provisioning template points SIP at a VPN address.**
Landau/tenant-21 template `a70274ea0f143ca0` has **P47 (account-1 SIP server) = 10.8.0.1** and 12
total refs to 10.8.0.1 — Create A Box's OpenVPN gateway. The phone can NEVER register with this from
Izzy's home (no VPN). This is NOT the delivery mechanism: the phone would fail on ANY delivery.
Root cause: when the wizard released the record from Create A Box (tenant 7) and generated the new
tenant-21 template, it carried CAB's VPN SIP server instead of the standard public host. Proof it's
a one-off bug: across all provisioning templates, **3 use the correct `209.145.60.79`; only this
moved one uses 10.8.0.1.** (OpenVPN itself is OFF — P8460 empty — and there's no VLAN/static-IP
change; the only contamination is the SIP server + Create A Box's ping/web hardening.)

⚠️ **The test phone is offline to the LAN now** — it applied the pushed config (ARP resolves at
.172 but ping + HTTPS are dead, per CAB's hardening). Recover by a physical factory reset (hold OK
~10 s) OR by pushing a CORRECTED config via GDMS (mechanism proven) once the template SIP server is
fixed. ⛔ Did NOT push a corrected config or edit the PBX template — both are writes needing Izzy's
go-ahead (PBX is read-only by default; one blind push already locked the phone).

**Path to the real fleet proof:** (1) fix moved-phone template generation to use the destination
tenant's public SIP host (209.145.60.79), not the source's; (2) productionize the GDMS `config/xml`
push in gdmsClient (multipart + form signature above) + provider + wiring + simulator tests; (3)
push the corrected config via GDMS, watch T21_101 register from the phone's LAN IP; (4) lock it with
a repeatable factory-reset→register test. Only then is "every Grandstream, flawlessly" earned.

## 10l. Round 13 (2026-09-15) — phone REGISTERED via the GDMS push (transiently); root cause = no public GXP2170 template

Izzy authorized the writes ("do the writes"). Did them, and got the real registration — briefly.

✅ **The GDMS push + a corrected SIP server REGISTERED the phone.** Fetched the phoneprov cfg,
substituted 10.8.0.1 → 209.145.60.79 (×13), pushed via `device/config/xml` (retCode 0), GDMS reboot
task accepted. The phone applied it and **registered as `T21_101` to 209.145.60.79, contact went
`Avail`** (proven at 13:43Z). End-to-end proof: GDMS cloud delivery + correct config = a registered
Grandstream, no LAN/password.

⛔ **But it did NOT stay registered — it flaps.** Minutes later the `T21_101/` desk contact was gone
(only the `_1` app contact left). Cause: the phone's P237 still points at phoneprov, and phoneprov
**regenerates the cfg on every request** from the shared Create A Box template (10.8.0.1). So on its
provisioning re-pull the phone reverts to 10.8.0.1 and de-registers. The GDMS-pushed good config wins
only until the next phoneprov pull.

⛔⛔ **ROOT CAUSE (exact): there is NO public GXP2170 template.** `provisioning.templates` for model
64 (GXP2170) has only id 15 ("gxp2170 102") and id 16 ("Gxp 106") — BOTH tenant 1, shared=yes, both
carrying Create A Box's VPN server 10.8.0.1. `chooseTemplate` (packages/shared provisioningRecord.ts)
finds no tenant-owned template for Landau, falls back to the first shared one (id 15) → 10.8.0.1.
So EVERY GXP2170 provisioned for a non-CAB tenant through this PBX gets the VPN server. (The 3
templates that correctly use 209.145.60.79 are for OTHER models.) ⛔ Editing template 15/16 is
FORBIDDEN — Create A Box's live phone uses them.

**The durable fix (NOT done — needs design + test, not a 2am live hack):** one of — (a) create a
public GXP2170 template (server 209.145.60.79, no CAB hardening) and have `chooseTemplate` prefer a
non-VPN template for public tenants; and/or (b) productionize the GDMS `device/config/xml` push in
gdmsClient (multipart + form signature, memory [[gdms-openapi-provisioning-spec]]) AND repoint the
phone's P237 to GDMS so GDMS is the sole config source and the phoneprov re-pull can't revert it;
then a repeatable factory-reset→register test. Until then, no GXP2170 registers STABLY from provisioning.

⚠️ **Phone state:** currently flapping / not stably registered, web+ping off (CAB hardening in the
pushed cfg). Clean recovery = physical factory reset (hold OK ~10 s) or a GDMS factory-reset task.
Left to Izzy — no more blind config pushes.

## 10m. Round 14 (2026-09-15) — THE SOURCE IS FIXED: clean per-model template created from the stock base; Izzy's flow is the design

Izzy set the architecture, verbatim spirit: templates are reusable — ONE per model, the system
fills it in per phone; the flow is (0) factory reset automatically, (1) ensure a template for the
model, (2) add the phone to provisioning, (3) take the rendered template and send it to the phone +
restart. The per-customer templates on this PBX were only his organizational habit.

✅ **The exact defect and the fix, both proven:**
- Working templates set the server with a PLACEHOLDER (`<P47>{{ $accounts[0]['sip_domain'] ?? null }}`).
  CAB's model-64 templates 15/16 hand-hardcode `<P47>10.8.0.1</P47>` (their VPN) — poison for anyone else.
- **VitalPBX ships clean stock bases per model:** `/var/lib/vitalpbx/provisioning/base_templates/
  grandstream/<model>/template.cfg` — placeholder-based, zero VPN. This is the source for clean templates.
- **Created template 60 "GXP2170"** (model 64, tenant 1, shared=yes): provision = the stock base
  VERBATIM, VPK keys blanked (no "Mrs. Koufman" leaking). Script pattern: clone row 15 → UPDATE
  provision via UNHEX(hex) OVER STDIN (⛔ a 1MB hex literal on argv dies "Argument list too long").
- **Set 15/16 shared='no'.** ⛔ Blast radius verified: the shared flag ONLY affects `chooseTemplate`'s
  fallback for NEW phones; bound devices render by template_id regardless — CAB unaffected. With 60 the
  only shared model-64 template, `chooseTemplate` now picks it for any tenant — NO code change needed
  for selection.
- **Rebound device 78 → 60** and forced a re-render. ⛔⛔ THE CFG IS A DISK CACHE: `index.php` only
  calls `generateProvisioningFile()` when the file is MISSING — a DB rebind changes nothing served
  until you DELETE `provisioning_templates/<tenant-hash>/cfg<mac>.xml` and re-fetch. Re-render proven:
  `P47=209.145.60.79`, zero 10.8.0.1, zero Koufman, account T21_101 intact.
- The corrected config was pushed to the phone via GDMS + reboot (both 200); registration watch
  running at write time. Stable this time by construction: phoneprov itself now serves the same
  correct config, so a re-pull cannot revert it.

⛔ **Device 24 = the OTHER Landau GXP2170 (C0:74:AD:8C:65:4E, .171) has the SAME bug** — still bound
  to CAB template 16. Rebind to 60 + delete its cached cfg once 78 proves out.

**PBX writes made (Izzy-authorized, backups in `/root/landau-template-fix-<stamp>/`):** template 60
created; 15/16 shared='no'; device 78 template_id 15→60; cached cfg deleted/regenerated. Plus GDMS
config pushes + reboot/factory-reset tasks to C0:74:AD:8C:60:5F.

**REMAINING CODE BUILD (the wizard doing it, hands-off):** (1) writer ensures a clean template for
ANY Grandstream model — create from the stock base when missing (the manual pattern above, in code,
via the PBX helper/panel contract); (2) productionize the GDMS `device/config/xml` push
([[gdms-openapi-provisioning-spec]]) and wire it as the wizard's delivery step (render → push →
reboot); (3) tests + deploy; (4) the hands-off proof: factory phone, wizard run, registers untouched.

## 10n. Round 15 (2026-09-15) — BUILDING THE WIZARD TO DO IT: GDMS delivery in the client, clean per-model templates, chooseTemplate preference

Izzy: "I want the WIZARD to do it, not you." So the manual fixes became product. Three pieces:

✅ **A — GDMS cloud config-push in the client (`f968b531`).** `GdmsClient.pushDeviceConfigXml`
(multipart: `mac` field + `xml` FILE part) signed by the new `gdmsFormSignature` (all params
sorted, file value = md5(bytes); a JSON body is refused "bad signature"). `GrandstreamProvider.
pushConfig(mac, xml)` delivers a rendered gs_provision config to a claimed device over the cloud.
The pre-existing `pushConfig(mac)` interface stub upgraded to `(mac, xml)`. Simulator accepts the
upload + verifies the form signature. 37/37 provider tests.

✅ **B — clean per-model templates + `chooseTemplate` preference (`ba62cfec` + a PBX seed).** The
root cause was that the only shared GXP2170 templates were Create A Box's, hand-hardcoded to their
VPN server. FIX in two halves: (1) CODE — `PbxTemplate.generic` (the `loopcom_clean_` unique_name
marker, read by the writer); `chooseTemplate` now prefers own → CLEAN generic → any shared. 34/34
shared tests. (2) DATA — seeded **61 clean shared templates, one per Grandstream model**, from
VitalPBX's OWN stock bases (`/var/lib/vitalpbx/provisioning/base_templates/grandstream/<slug>/
template.cfg` — placeholder server `{{ $accounts[0]['sip_domain'] }}`, zero VPN), named `<MODEL>`,
`unique_name=loopcom_clean_<model_id>`, keys blanked. Model→id map from `provisioning.phone_models`
(lower(model)==slug). ⛔ HT814 skipped (its stock base uses a different placeholder — no sip_domain).
Backups `/root/grandstream-template-seed-<stamp>/`. So every Grandstream model now has a clean
default the picker prefers, for any tenant — Izzy's "one template per model."

⛔⛔ **SEED SCRIPT TRAPS (both cost a rerun):** `keys` is NOT NULL (blank it to
`{"fixed_vpk_keys":{},"dynamic_vpk_keys":{}}`, never NULL); a ~500KB `UNHEX('<hex>')` UPDATE must go
over STDIN, never argv ("Argument list too long"). And the marker-alignment for the pre-existing
template 60 ran AFTER the loop, so the gxp2170 iteration made a DUPLICATE loopcom_clean_64 (105) —
deleted; device 78 stays on 60. Verify markers are unique after any reseed.

⏳ **C — NOT BUILT: wire the GDMS push as the wizard's SEND step.** Today the wizard still delivers
via the PnP resident / `set_provisioning` (LAN) — which now works because the phoneprov config is
correct. The durable, LAN-independent send is to call `provider.pushConfig(mac, renderedXml)` from
the server-side `/prepare` flow (render the phoneprov cfg → push → reboot). deviceMechanismsFor +
/prepare + the driver + tests. That is the last piece for "send it from the cloud, every time."

✅ **NET:** A+B DEPLOYED (api at `ba62cfec`). The wizard now produces a CORRECT config for any
Grandstream model via clean templates, and can deliver it over the cloud (mechanism built). A
hands-off wizard run on a factory phone is the proof still owed. Device 24 (65:4E) — rebind to a
clean template too (or let a fresh wizard run do it now that chooseTemplate is fixed).

## 10o. Round 16 (2026-09-15) — THE WIZARD DOES IT: cloud SEND wired into /prepare; all three pieces DEPLOYED

Izzy's flow, now automated end to end: (0) reset-first → (1) clean per-model template ensured →
(2) phone added to provisioning → (3) rendered config SENT over the cloud → reboot → register.

✅ **C — the SEND step (`2e7aaafd`, api DEPLOYED).** `/prepare` now, once a Grandstream is in the
maker's account and NOT wiping this round, renders the PBX config and pushes it through GDMS
(`provider.pushConfig`) — the delivery that actually reaches a claimed phone (PnP multicast unheard;
HTTP config no-ops on a GDMS-claimed device). New ctx dep `renderDeviceConfig` fetches
`cfg<mac>.xml` the way the phone would; the config comes from the CLEAN per-model template (Round
15), so the server is right. ⛔ Skipped while wiping (a wiped phone takes nothing — sent next
prepare); best-effort (a failed send never aborts reset/reboot); logged as a `reprovision` step /
`DESK_PHONE_PREPARE_STEP`. RESET-FIRST invariant intact. 154/154 desk-phone api tests (2 new).

✅ **Both Landau GXP2170s corrected:** device 78 (60:5F) and device 24 (65:4E) rebound to the clean
template 60; both now render `P47=209.145.60.79`, zero 10.8.0.1. Backups `/root/device24-clean-*`.

✅✅ **THE WHOLE BUILD (this session), all DEPLOYED on api:** A `f968b531` (GDMS `device/config/xml`
push + `gdmsFormSignature`), B `ba62cfec` (chooseTemplate prefers a CLEAN generic template) + a PBX
seed of 61 clean Grandstream templates from the stock bases, C `2e7aaafd` (the /prepare cloud send).
Memory: [[gdms-openapi-provisioning-spec]], [[grandstream-zero-touch-needs-gdms-redirect-not-lan]].

⏳ **THE ONE THING STILL OWED: a hands-off wizard run on a factory phone, proven to register
untouched.** Every mechanism is built, deployed, and unit-proven; the config renders correctly and
the cloud send is wired. What has NOT happened since the final deploy is a person running the wizard
on a factory-reset phone and watching it register with no manual steps — that is the acceptance
proof, and it is Izzy's to trigger (his machine, his phone). Until then: mechanisms proven, the
end-to-end hands-off run is not yet witnessed. ⛔ HT814 has no clean template (its stock base uses a
different placeholder — no sip_domain); every other Grandstream model is covered.

## 10p. Round 17 (2026-09-15) — the deployed-code pass: every step correct, but the phone is OFFLINE in GDMS so nothing lands

Took another pass with the DEPLOYED code — imported the SHIPPED GdmsClient from
/app/apps/api/src/deskPhoneSetup/gdmsClient.ts inside app-api-1 (via `npx tsx` from /app/apps/api),
not probe re-implementations — and ran the wizard's send sequence on C0:74:AD:8C:60:5F:
findDevice → found (model GXP2170); render → P47=209.145.60.79, 0×10.8.0.1, gs_provision=true;
pushDeviceConfigXml → retCode 0; createTask reboot → task 15538619. Every step executed correctly.

⛔⛔ **BUT the phone is OFFLINE in GDMS (`device/list` status:0).** It pings on the LAN and serves
HTTP 200 (factory-clean, on the network) but has NOT re-attached to the GDMS cloud since its factory
reset. So the push and reboot QUEUE against a phone that is not connected — retCode 0 on the push,
reboot task stuck at status 2 (never completes) — and a 13-minute registration watch saw 0 T21_101
desk registrations. Only the app (T21_101_1) is registered.

⛔ **THE LESSON: retCode 0 ≠ delivered. GDMS delivery requires the phone ONLINE in GDMS.** A phone
phones home to fm.grandstream.com/gs on boot with internet; until it does, the cloud send silently
waits. For a real out-of-box customer phone that check-in is the normal path, but it is a genuine
link in the chain and has NOT been witnessed completing once. Recovery for Izzy's phone: power-cycle
it so it re-checks into GDMS, then the queued config+reboot apply and it should register (and STAY,
because phoneprov now serves the same correct config). Memory: [[grandstream-zero-touch-needs-gdms-redirect-not-lan]].

Also this round: landed the TESTS_RUN entry (`d36d829a`) and a stranded local BDC-filing commit
(`fc31c28d`); realigned the local branch to origin (all desk-phone code was already pushed; kept
origin's newer handoff copy). No code change this round — it was a verification pass.
## 11. Traps hit

- A new provider action added to one of two route files is invisible to the route-order guard unless
  the guard reads both — it does now.
- `TenantBillingSettings`-style transposition: the fake db in the route tests enforces the enum-like
  values and snapshots rows.
- Staff wording must not carry vendor tokens either ("retCode" leaked into a staff message; reworded).
- The Grandstream model read must be scoped to Grandstream pages or it breaks the LAN flood cap.
- `class X extends <required module>` loses its constructor type in TS — cast before `new`.
