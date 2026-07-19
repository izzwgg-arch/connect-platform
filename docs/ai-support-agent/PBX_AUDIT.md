# PBX Capability Audit — what the agent CAN and CANNOT create

_Read-only audit, 2026-07-19. Live box: `vmi2718844` (209.145.60.79). **VitalPBX 4.5.3**, api module 4.5.1, AI-Assistants + Twilio-AI modules installed. Source: the actual `api_v2/*/create.php` handlers + the `ombutel` database schema on the live PBX. No writes performed._

## The headline answers to your question

| Object | Create via agent? | How |
|---|---|---|
| **Queues** | ✅ **YES** | Official API `POST /api/v2/queues` — clean, supported, safe |
| **Extensions** | ⚠️ **Not via the API** | API is **read-only** for extensions. Creatable only via GUI, a Connect helper, or direct DB+regen (see paths below) |
| Tenants | ✅ YES | Official API `POST /api/v2/tenants` |
| Devices (SIP endpoints) | ✅ YES | Official API `POST /api/v2/devices` |
| Virtual faxes | ✅ YES | Official API |
| Auth codes / customer codes / AI API keys | ✅ YES | Official API |
| IVRs | ❌ Not via API | No API module at all; DB table `ombu_ivrs` exists (GUI/DB only) |
| Ring groups | ❌ Not via API | No API module; DB table `ombu_ring_groups` exists |
| Time conditions | ❌ Not via API | No API module; DB table `ombu_time_conditions` exists |
| Inbound routes | ❌ Not via API | No API module — **but Connect already has a helper for this** (see Path 2) |
| Outbound routes | ❌ Not via API | Read-only in API; DB only |
| Trunks | ❌ Not via API | Read-only in API |

## What the official API actually supports (verified on the box)

`create.php` handlers present → **creatable via API:** `tenants`, `queues`, `devices`, `virtual_faxes`, `auth_codes`, `customer_codes`, `ai_api_keys`, `core` (click-to-call/dialer).

**Read-only in the API** (list/get only, no create): `extensions`, `outbound_routes`, `trunks`, `conferences`, `parking_lots`, `destinations`, `route_selections`, `roles`, `users`, `agents`, `classes_of_services`, `device_profiles`, `account_codes`, `phonebooks`, `cdr`.

**No API module at all** (managed only by the GUI / underlying config): `ivrs`, `ring_groups`, `time_conditions`, `inbound_routes`.

## The three ways to create anything on this PBX (ranked by safety)

**Path 1 — Official API (safe, preferred).** Covers tenants, queues, devices, faxes, codes. This is what the agent's Scoped Executor should use for those. Reversible, scoped, low blast radius.

**Path 2 — Connect helper scripts (controlled bridge).** Connect already ships helpers on the PBX for gaps the API leaves — e.g. the inbound-route helper (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`) and `connect-prompt-sync` for IVR prompt audio. This is the proven pattern to safely enable **inbound routes** and **IVR prompt uploads** without the API. New helpers (e.g. a narrow "create extension" helper) could be added the same way — each one owner-reviewed.

**Path 3 — Direct DB + `vitalpbx gen-conf` + apply (powerful, HIGH RISK).** Every object lives in the `ombutel` MariaDB (`ombu_extensions`, `ombu_ivrs`, `ombu_ivr_entries`, `ombu_inbound_routes`, `ombu_ring_groups`, `ombu_time_conditions`, `ombu_queues`, …). Writing those tables + regenerating config can create anything the GUI can. **This is exactly the class of operation behind the June-2026 DID-wipe incident** — a config regenerate on a live box. It is the last resort, never automatic, and only under a scheduled PW-2-style window with a verified rollback.

## Correction to the provisioning catalog (important, honest)

My earlier `PROVISIONING_CATALOG` (P1–P14) optimistically assumed REST endpoints like `/api/v2/extensions` (create), `/api/v2/ivrs`, `/api/v2/inbound_routes`, `/api/v2/ring_groups`, `/api/v2/time_conditions`. **Those endpoints do not exist on this PBX.** The certification suite passed only because it runs in **simulation mode**, where the sim client returns success for any path without checking the endpoint is real. This audit is precisely what live validation (PW-2) is designed to catch — and it caught it *before* any live attempt. Nothing was ever sent to the PBX.

The catalog is now re-graded by real feasibility (code updated alongside this doc):

| Catalog op | Real path | Live-feasible today? |
|---|---|---|
| P1 Create tenant | API | ✅ |
| P2 Add inbound DID | API (`inbound_numbers`) | ✅ |
| P3 Apply changes | API | ✅ |
| P4 Create extension | Helper or DB+regen | ⚠️ needs a helper (not API) |
| P5 Create device | API | ✅ |
| P7 Create IVR | DB+regen | ⚠️ GUI/DB only |
| P8 Create inbound route | **Connect helper (exists)** | ✅ via helper |
| P9 Create outbound route | DB+regen | ⚠️ |
| P10 Create ring group | DB+regen | ⚠️ |
| P11 Create queue | API | ✅ |
| P12 Create time condition | DB+regen | ⚠️ |
| P13 Virtual ext/conference/fax | API (fax/virtual) partial | ◐ partial |
| P14 IVR prompt audio | **`connect-prompt-sync` (exists)** | ✅ via helper |

## Bonus finding — directly relevant to your voice-agent goal

The PBX already has **`vitalpbx-ai-assistants`** ("AI Voice Agents using speech-to-text and text-to-speech pipelines") and a **`twilio-ai`** module installed, plus an `ai_api_keys` API you can create keys through. When we build the Phase-6 conversational IVR, this native module is a real integration option to evaluate alongside the ARI/AudioSocket path — potentially a big shortcut for the live phone agent.

## Recommendation

1. **Ship the API-native creates now** (tenant, queue, device, DID, codes) — these are safe and real; the agent can do them through the Scoped Executor once live-enabled at PW-2.
2. **Use the existing helpers** for inbound routes and IVR prompt audio.
3. **For extensions / IVRs / ring groups / time conditions:** build narrow, owner-reviewed **helper scripts** (Path 2) rather than direct DB writes — same safe pattern Connect already uses. Each helper gets its own PW-2-style live validation.
4. **Reserve Path 3 (DB+regen)** for nothing automatic — owner-run, windowed, with rollback, given its blast radius.
