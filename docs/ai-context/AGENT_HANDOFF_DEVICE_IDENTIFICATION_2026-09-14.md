# Desk Phone Wizard — automatic device identification + maker-cloud providers (2026-09-14)

**Status: BUILT, TESTED, COMMITTED. NOT DEPLOYED. Migration NOT applied. No GDMS credential
stored. No live call to any maker cloud has been made. No phone was touched.**

Branch `feat/ivr-migration-takeover`. This upgrades the EXISTING Desk Phone Wizard — no second
wizard, no demo screen, the reset ladder and the setup driver are untouched.

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
  manual if absent); reprovision; **factory reset only when the device is locked to another
  provider AND the cloud cannot re-point it AND a reset is possible AND the person authorised it**;
  assign SIP; verify registration.
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
| `POST …/prepare` `{dryRun?}` | own **running** run + can set up; factory reset additionally needs the reset permission |
| `GET/POST /admin/desk-phones/gdms-credentials` | SUPER_ADMIN; never echoes a value |
| `POST /admin/desk-phones/gdms-credentials/verify` | SUPER_ADMIN; refuses a simulated mode |

The route-order guard now reads BOTH route files (ownership → permission → body).

## 7. Safety properties (each has a test)

- **Tenant isolation**: another customer's device reads exactly like one that does not exist
  (404 on all five device routes; nothing reaches the maker).
- **Ownership / conflict**: a MAC another Loopcom tenant manages (or is claiming, within 10 min) →
  `device_ownership_conflict`, never re-registered. A maker refusal is flagged
  `possibleOwnershipConflict` and never marked managed. Two tenants claiming the same device at
  once → exactly one wins (Postgres advisory lock `desk-phone-claim:<mac>`).
- **Factory reset** (never automatic): planned only as in §2; then `allowedToReset` + the
  per-phone approval + `decideReset`; the one reset is **spent atomically on `resetCount` BEFORE
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
single spend / racing prepares / refusal gives the reset back / no permission → 403, staff-only
credential screens.

## 10. NOT PROVEN — and what enabling needs

- **Nothing is deployed.** api + portal deploy (the api deploy applies the migration); desktop needs
  an installer build + install/publish (Izzy's call).
- **No GDMS credential is stored and no live GDMS call has ever been made** — so the live-safe
  validation the prompt asks for (read-only lookup against the real account) has not run. Enable:
  confirm `CREDENTIALS_MASTER_KEY` is set in `app-api-1` (else the save answers 503), save the API ID
  + secret + the GDMS login from **Admin → GDMS** (⛔ never through chat), press **Verify**, then run
  **vendor-lookup** on Izzy's test GXP2170 (`C0:74:AD:8C:60:5F`, S/N on its sticker). ⛔ Claim, reboot
  and reset only on a designated test device, by Izzy.
- **Conflict with Izzy's standing rule, flagged not resolved:** the prompt says never auto-reset;
  Izzy's 2026-09-14 rule says reset every ticked phone first. The existing wizard ladder (reset-first)
  is **unchanged**; the new `/prepare` follows the prompt's capability-driven rule. Which one governs
  the wizard's main path is Izzy's decision.
- Yealink RPS still has no credentials (tickets pending); Fanvil and Poly have no API access at all.
- The new card line and label box have not been seen in a browser.

## 11. Traps hit

- A new provider action added to one of two route files is invisible to the route-order guard unless
  the guard reads both — it does now.
- `TenantBillingSettings`-style transposition: the fake db in the route tests enforces the enum-like
  values and snapshots rows.
- Staff wording must not carry vendor tokens either ("retCode" leaked into a staff message; reworded).
- The Grandstream model read must be scoped to Grandstream pages or it breaks the LAN flood cap.
- `class X extends <required module>` loses its constructor type in TS — cast before `new`.
