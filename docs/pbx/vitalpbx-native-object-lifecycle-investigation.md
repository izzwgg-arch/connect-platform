# VitalPBX Native Object Lifecycle — Investigation

> **Status:** Audit / research only. No changes, no writes, no deploy, no DB
> mutations, no AstDB writes, no config edits. This document maps how VitalPBX
> stores, creates, updates, deletes, and applies native PBX objects, based only
> on evidence in the repo and the read-only PBX brain bundle.
>
> **Primary evidence:**
> - Schema DDL: `docs/pbx-brain/extracted-useful/pbx-full-brain-20260609-063057/vitalpbx/vitalpbx/migrations/20191218.3.tables.sql`
> - Seed/module map: `.../migrations/20191218.4.data.sql`
> - Generated Asterisk config: `.../etc-asterisk/asterisk/vitalpbx/*.conf`
> - REST surface: `.../vitalpbx/www/api_v2/**` (most handler bodies ionCube-encoded)
> - Connect adapter: `packages/integrations/src/vitalpbx/client.ts`, `endpointRegistry.ts`
> - Connect apply/reload usage: `apps/api/src/server.ts`, `scripts/pbx/*.sh`,
>   `scripts/pbx/install-vitalpbx-inbound-route-helper.sh`
>
> **Skeptic's note up front:** the create/update/delete logic for every native
> object is **ionCube-encoded PHP** (`www/modules/*/*.php`,
> `www/api_v2/*/create.php`, `www/includes/asterisk/*`,
> `www/includes/ModulesDB.php`). We can read **table shapes**, **which REST files
> exist**, and **generated output**, but we **cannot read the actual write logic,
> ID allocation, validation, or config-generation rules**. Anything below about
> *how* a row is written or *what* invariants it must satisfy is inferred from
> schema + generated output and is explicitly marked. Do not treat inference as a
> green light to write.

Evidence tags used throughout: **[proven]** (read directly from a file),
**[inferred]** (deduced from schema/generated output), **[unknown]** (not
determinable from available evidence).

---

## 1. Executive Summary

### What is now proven

1. **Every native VitalPBX object is stored in the MariaDB `ombutel` database**
   as `ombu_*` tables. The Asterisk config under `/etc/asterisk/vitalpbx/*.conf`
   is **generated output**, not a source of truth. **[proven —
   `20191218.3.tables.sql`, generated `pjsip__50-8-extensions.conf`]**
2. **VitalPBX uses a per-tenant, per-module "queued changes" apply model.** The
   table `ombu_queued_changes(tenant_id, module_id)` exists specifically to track
   which module's config is dirty for which tenant. **[proven —
   `20191218.3.tables.sql:78-85`]** "Apply Changes" regenerates the affected
   config and reloads Asterisk. The REST equivalent is
   `PUT /api/v2/tenants/:id/apply_changes`, which Connect already wraps as
   `syncTenant()`. **[proven — `client.ts:428-430`, `endpointRegistry.ts:104`,
   `server.ts:14816`]**
3. **The documented + present REST write surface is small.** Across all of
   `www/api_v2/`, the only directories containing `create.php` / `delete.php` /
   `update.php` are: **tenants, devices, queues, virtual_faxes, customer_codes,
   auth_codes, ai_api_keys, voicemail (update/delete), core (create)**. **[proven
   — directory listing of `www/api_v2/**`]**
4. **There is NO REST create/update/delete file for** extensions, trunks,
   outbound_routes, inbound_route, ivr, ring_group, time_conditions,
   classes_of_service, music_on_hold, feature_code, or emergency_numbers. Those
   directories have `read.php` only (or do not exist as API dirs). **[proven]**
5. **`ombu_devices.secret` is the SIP credential, stored in plaintext** in the
   DB; the generated PJSIP `auth` section's `password` is derived from it.
   `ombu_pjsip_devices` holds only codecs/dtmf/contacts. **[proven —
   `20191218.3.tables.sql:474-492, 754-763`; `pjsip__50-8-extensions.conf:32-36`]**
6. **A `devices/create.php` REST endpoint physically exists** but is **not** in
   VitalPBX's public Postman collection and **not** wrapped by Connect's
   `endpointRegistry.ts`. **[proven — file exists; absent from `endpointRegistry.ts`]**
7. **Routing uses a polymorphic indirection table `ombu_destinations`**
   `(category_id, module_id, index)`. IVRs, inbound routes, time conditions,
   queues, and ring groups all point at a `destination_id`, not directly at the
   target object. **[proven — `20191218.3.tables.sql:146-164` + every
   `*destination_id*` FK]**

### What remains unknown

- The **actual create/validation/ID-allocation logic** for every object
  (ionCube). **[unknown]**
- Whether `devices/create.php` can create a device **and** its parent extension,
  or only attach a device to an existing extension; its required payload; its
  side effects on `ombu_queued_changes` and config regen. **[unknown]**
- Whether VitalPBX admin UI modules expose **undocumented AJAX write endpoints**
  beyond `api_v2` (e.g. `www/modules/*/save.php`-style handlers). The module PHP
  is ionCube; the routing is not readable. **[unknown]**
- The **exact config-generation rules** (`www/includes/asterisk/Configurations.php`,
  `DialPlan/*.php`) that turn a DB row into a `.conf` fragment. **[unknown]**
- Live production row values (no `mysqldump` in the bundle). **[unknown — confirmed
  absent, `RISKS_AND_LIMITATIONS.md`]**

### Can Connect safely create native objects yet?

**No — not for the native objects that lack a REST write path, and not even via
the endpoints that do exist, until each is validated in a lab.** The only writes
that are *supported and already exercised* by Connect are tenant lifecycle,
queue CRUD, tenant inbound-number routing, voicemail delete/mark, and the overlay
AstDB path. Everything else (extensions, devices, trunks, routes, IVRs, ring
groups, time conditions, COS, MOH, feature codes, emergency) has **no proven safe
programmatic create path** and should be treated as **manual-only** until the
§8 lab test produces evidence.

### Which objects have a real supported path

| Object | Supported write path | Confidence |
|--------|----------------------|------------|
| Tenants | REST `tenants.create/update/delete/changeState/applyChanges` | **proven endpoint, exercised by Connect** |
| Queues | REST `queues.create/update/delete` | **proven endpoint** |
| Tenant inbound numbers (DID → destination) | REST `tenants.addInboundNumbers/removeInboundNumbers` (PATCH/DELETE) | **proven endpoint** |
| Voicemail message | REST `voicemail.delete/markListened` | **proven endpoint** |
| Codes (auth/customer/AI) | REST CRUD | **proven endpoint** |
| Devices/SIP endpoint | REST `devices/create.php` (UNDOCUMENTED) | **endpoint exists; behaviour unverified** |
| Routing/IVR/MOH/hold (overlay) | AstDB via telephony `DBPut` | **proven, in production** |

### Which objects require deeper live testing

Extensions, devices (`devices/create.php` behaviour), trunks, outbound routes,
inbound routes (native, not overlay), native IVRs, ring groups, time conditions,
classes of service, MOH classes, feature codes, caller-ID management, and
**emergency/911** — all require the §8 lab experiment before any automation claim.

---

## 2. Object Lifecycle Matrix

"Creation path" reflects what is **provable**. Where the only known mechanism is
the ionCube VitalPBX UI module writing to MariaDB, it is shown as
"UI module → MariaDB (ionCube)". "REST create" means a `create.php` file exists
in `api_v2` (behaviour still ionCube).

| Object | Storage (ombutel table) | Creation path | Update path | Delete/disable path | Apply/reload | Key dependencies (FK) | Safe to automate now? | Risk | Evidence |
|--------|-------------------------|---------------|-------------|---------------------|--------------|-----------------------|-----------------------|------|----------|
| **Tenant** | `ombu_tenants` (+`ombu_tenant_settings`) | REST `tenants.create` | REST `tenants.update` | REST `tenants.delete` / `changeState` (enable/disable) | `tenants.applyChanges` (full per-tenant apply) | none (root object) | **Partly** (record yes; *usable* tenant needs many child objects w/ no REST path) | Med | `tables.sql:14-33`; `client.ts:410-430` |
| **Extension** | `ombu_extensions` (+`ombu_extensions_vm`) | **No REST create**; UI module → MariaDB (ionCube) | none via REST | none via REST | queue `extensions` module + apply | **`class_of_service_id` NOT NULL**, `tenant_id`, optional `dial_profile_id`/`ars_id`/`music_group_id`/`mailbox` | **No** | High | `tables.sql:319-372`; no `extensions/create.php` |
| **Device / endpoint / SIP cred** | `ombu_devices` (`secret` plaintext) + `ombu_pjsip_devices`/`ombu_sip_devices` | **REST `devices/create.php` (UNDOCUMENTED)** or UI→MariaDB | `devices/route.php` (verbs unknown) | `devices/route.php` (unknown) | queue `extensions`/`endpoint` + apply (PJSIP regen + `module reload res_pjsip.so`) | `extension_id`, `profile_id` (device profile/technology) | **No (untested)** | High | `tables.sql:474-492,754-763`; `devices/create.php` exists |
| **Device profile / technology** | `ombu_device_profiles` (+`ombu_pjsip_profiles`/`ombu_iax_profiles`) | UI→MariaDB (ionCube); REST `device_profiles` read-only | unknown | unknown | endpoint/pjsip regen | `technology`; `webrtc` flag in pjsip profile | **No** | Med | `tables.sql:127-145,506-535` |
| **Trunk** | `ombu_trunks` (+`_parameters`,`_rules`,`ombu_tenant_trunks`) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `trunks` + apply (PJSIP/IAX trunk regen) | `class_of_service_id` (cascade), `profile_id`, `tenant_id`/`tenant_trunk_id` | **No** | **High** | `tables.sql:790-865`; `client.ts:495-497` throws |
| **Outbound route** | `ombu_outbound_routes` (+`_members`→trunk, `_patterns`, `ombu_ars_members`) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `inbound_route`/`ars` + dialplan regen | `destination_id`, member `trunk_id`, `pin_list_id`, COS via ARS | **No** | **High** | `tables.sql:1467-1519`; `client.ts:503-505` throws |
| **Inbound route (native)** | `ombu_inbound_routes` | **No REST create**; UI→MariaDB. (Connect helper flips `destination_id` only) | Helper UPDATE `destination_id` (snapshotted) | none/disable via UI | queue `inbound_route` + dialplan regen; helper runs `dialplan reload` | `did`, `destination_id`→destinations, `cos_id`, `cid_management_id`, `music_group_id` | **Flip-only** (via helper) | **High** | `tables.sql:1283-1325`; `install-vitalpbx-inbound-route-helper.sh` |
| **IVR (native)** | `ombu_ivrs` (+`ombu_ivr_entries`) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `ivr` + dialplan regen | `class_of_service_id` (cascade), `welcome_msg_id`→recordings, entry `destination_id`→destinations | **No** (use Connect overlay) | Med | `tables.sql:1334-1387`; `client.ts:511-514` throws |
| **Ring group** | `ombu_ring_groups` (+`_members`→ext) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `ring_group` + dialplan regen | member `extension_id`, `destination_id`, `class_of_service_id`, `music_group_id` | **No** | Med-High | `tables.sql:1749-1779`; `client.ts:507-510` throws |
| **Queue** | `ombu_queues` (+`_members`→ext, `_priorities`, `_vip_lists`) | **REST `queues.create`** | REST `queues.update` | REST `queues.delete` | queue `queues` + dialplan/queues regen | `extension` number, member `extension_id`, optional `ivr_id`/`destination_id`/`music_group_id`/recordings | **Partly (untested at scale)** | Med | `tables.sql:1660-1739`; `client.ts:517-530` |
| **Time condition** | `ombu_time_conditions` (+`ombu_time_groups`,`_schedules`) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `time_conditions`/`time_group` + dialplan regen | `time_group_id` NOT NULL, match/mismatch `destination_id`→destinations | **No** (use Connect overlay schedule) | Med | `tables.sql:432-472`; module 79/32 |
| **Voicemail** | `ombu_extensions_vm` (config→`voicemail.conf`/`voicemail__*.conf`; messages on disk spool) | **No REST create** (created with extension); REST `voicemail.update/delete` (per-message) | REST `voicemail.update` (message state) | REST `voicemail.delete` (message) | voicemail regen + `voicemail reload` (inferred) | `extension_id`, `voicemail_timezone_id`, `context`, `mailbox` | **Per-message only** | Med | `tables.sql:374-398`; `client.ts:451-470` |
| **MOH (class)** | `ombu_music_groups` (+`ombu_music_files`); audio in `/var/lib/asterisk/moh/<class>` | **No REST create**; UI→MariaDB + file upload. Connect: AstDB class assignment + `connect-media-sync.sh` cron (`moh reload`) | UI / Connect overlay | UI | `moh reload` | `tenant_id`, files on disk | **Overlay-only** | Low-Med | `tables.sql:35-55`; `server.ts:22628` |
| **Feature codes** | `ombu_feature_codes` (+groups, categories, category_members) | **No REST create**; UI→MariaDB | none via REST | none via REST | dialplan regen | `feature_code_group_id`; bound to COS via `feature_code_category_id` | **No** | Med | `tables.sql:225-276` |
| **Caller-ID rules** | spread: `ombu_extensions.{internal,external,emergency}_cid`; `ombu_trunks.trunk_cid`/`overwrite_cid`; `ombu_outbound_routes.cid_*`; inbound `ombu_cid_management`/`ombu_cid_lookup` | **No dedicated REST**; set as fields on parent objects (UI→MariaDB) | with parent | with parent | parent's module apply | parent object | **No** | **High** (carrier identity / STIR-SHAKEN/CNAM not modelled) | `tables.sql:329-331,802-803,1290-1291,1473-1475` |
| **Emergency / 911** | `ombu_emergency_numbers` (+`ombu_emergency_number_categories`, `ombu_emergency_trunks`) | **No REST create**; UI→MariaDB | none via REST | none via REST | queue `emergency_numbers` (has_dialplan=yes) + dialplan regen | `category_id`, `trunk_id`; tenant `shared_trunks` setting | **NO — do not automate** | **Critical** | `tables.sql:1200-1230`; module 119 |

---

## 3. Native Object Dependency Graph

Derived from foreign keys in `20191218.3.tables.sql`. **[proven from FK constraints]**
Arrows mean "must exist before".

```
ombu_tenants
  ├─ ombu_device_profiles (technology; webrtc flag in ombu_pjsip_profiles)
  ├─ ombu_music_groups ──────────────► (+ ombu_music_files on disk)
  ├─ ombu_recordings (greetings/prompts)
  ├─ ombu_dialrules ─┐
  ├─ ombu_ars ───────┤
  ├─ ombu_feature_code_categories ─┐
  │                                ▼
  │                    ombu_classes_of_service  ◄── (NOT NULL on extension)
  │                                │
  ▼                                ▼
ombu_time_groups            ombu_extensions ──► ombu_extensions_vm (voicemail)
  │                                │
  ▼                                ├─► ombu_devices (SIP secret) ─► ombu_pjsip_devices
ombu_time_conditions               │
  (match/mismatch → destinations)  ▼
                            ombu_ring_groups / ombu_queues (members → extensions)
                                   │
ombu_destinations (category, module, index)  ◄── referenced by:
   ▲   ▲   ▲   ▲                              IVR entries, inbound routes,
   │   │   │   │                              time conditions, queues, ring groups,
   │   │   │   │                              night modes, custom destinations
ombu_ivrs ─► ombu_ivr_entries (option → destination_id)

ombu_trunks (COS) ─► ombu_outbound_route_members ─► ombu_outbound_routes (destination, patterns)
ombu_trunks ─► ombu_emergency_trunks ◄─ ombu_emergency_number_categories ─► ombu_emergency_numbers
ombu_inbound_routes (did → destination_id, cos_id, cid_management_id)
```

**Practical ordering to create a *usable* tenant from scratch** (every step below
the tenant currently has **no REST path** except queues):

```
tenant → class_of_service (needs feature_code_category + ars + dialrule)
       → device_profile/technology
       → extension (REQUIRES class_of_service)  → voicemail (extensions_vm)
       → device (SIP secret, REQUIRES extension + profile)
       → [for routing] ombu_destinations rows pointing at modules/indexes
       → ring_group / queue (members = extensions)
       → ivr (REQUIRES class_of_service + recordings + destinations)
       → trunk (REQUIRES class_of_service)
       → outbound_route (members = trunks; destination)
       → inbound_route (did → destination)
       → apply_changes (regenerate + reload)
```

The **`ombu_destinations` indirection** is the single biggest hazard: you cannot
"point a DID at an IVR" by writing an id; you must create/resolve a destination
row `(category_id, module_id, index)` whose semantics are defined in ionCube PHP.
**[inferred from schema; resolution rules unknown]**

---

## 4. VitalPBX Apply / Reload Model

**Proven mechanics:**

1. **Edits accumulate in `ombu_queued_changes(tenant_id, module_id)`.** One row =
   "this module is dirty for this tenant." Unique key `(tenant_id, module_id)`,
   FKs to `ombu_modules` and `ombu_tenants`. **[proven — `tables.sql:78-85`]**
2. **`ombu_modules`** enumerates 120+ modules with flags `(has_dialplan, admin,
   portal, multi_tenant)`. Call-flow objects (`extensions`, `queues`, `ivr`,
   `ring_group`, `trunks`, `inbound_route`, `time_conditions`,
   `emergency_numbers`, …) are `multi_tenant='yes'`. **[proven —
   `20191218.4.data.sql:5-109`]**
3. **Apply Changes** (per tenant) regenerates the tenant's Asterisk config
   fragments under `/etc/asterisk/vitalpbx/` (e.g.
   `pjsip__50-<tenant>-extensions.conf`, `extensions__50-<tenant>-dialplan.conf`,
   `queues__50-<tenant>-main.conf`) and reloads Asterisk. The fragments carry a
   generation header (`@Author : VitalPBX`, dated). **[proven — generated
   `pjsip__50-8-extensions.conf:1-6`; file naming across `vitalpbx/`]**
4. **REST entry point:** `PUT /api/v2/tenants/:id/apply_changes`. Connect already
   calls it (`tenants.applyChanges` → `syncTenant()`). **[proven —
   `endpointRegistry.ts:104`, `client.ts:428-430`, `server.ts:14816`]**
5. **Reload granularity (from Connect's own PBX-host scripts, not VitalPBX core):**
   `asterisk -rx "dialplan reload"`, `asterisk -rx "module reload res_pjsip.so"`
   (the canonical form; `pjsip reload` alias is missing on some builds),
   `asterisk -rx "moh reload"`. **[proven — `install-vitalpbx-inbound-route-helper.sh`,
   `install-connect-tenant-moh-dialplan.test.ts:230-241,358-365`]**

**Inferred (config generator):** the generator lives in ionCube
`www/includes/asterisk/Configurations.php`, `ConfigurationFile.php`,
`DialPlan/*.php`, `Driver.php`. These convert `ombu_*` rows → `.conf`. The exact
mapping (e.g. how COS becomes `context=T8_cos-103`, how a device becomes an
`auth`/`aor`/`endpoint` triple) is **not readable**. **[inferred — file names
present, bodies ionCube]**

**Skeptical implication:** writing `ombu_*` rows directly **without** the
generator's invariants and **without** queueing the right `(tenant_id,
module_id)` and **without** triggering the matching reload will produce a state
where **the DB and the running Asterisk config disagree** (silent drift, or a
broken `apply_changes` later). This is the central reason native direct-write is
unsafe.

---

## 5. REST API vs Internal Path

### (a) Documented REST write paths (in Connect's `endpointRegistry.ts` AND present as PHP)
- `tenants.create/update/delete/changeState/applyChanges` **[proven]**
- `tenants.addInboundNumbers/removeInboundNumbers` (PATCH/DELETE inbound_numbers) **[proven]**
- `queues.create/update/delete` **[proven]**
- `voicemail.delete/markListened` **[proven]**
- `authorizationCodes.* / customerCodes.* / aiApiKeys.*` CRUD **[proven]**
- `core.clickToCall / dialerCall`, `sms.send`, `whatsapp.*`, `virtualFaxes.send` (call/message actions, not config) **[proven]**

### (b) Undocumented/internal REST write paths (PHP file exists, NOT in Connect registry, behaviour ionCube)
- **`devices/create.php`** — create a device/SIP endpoint. **Not wrapped, not in
  Postman collection, payload + side effects unknown.** **[proven file exists;
  behaviour unknown]**
- `devices/route.php`, `device_profiles/route.php`, `tenants/route.php`,
  `queues/route.php`, `core/create.php`, `pms/route.php` — `route.php` files
  define sub-routes/verbs we cannot read (ionCube). May expose additional verbs.
  **[unknown]**
- VitalPBX admin UI module write handlers (`www/modules/*/*.php`) — almost
  certainly exist (the UI creates everything) but are **not** `api_v2` and their
  routing/auth is **unknown** (ionCube). **[unknown]**

### (c) Direct DB-only paths (no REST file at all)
Objects whose only known write mechanism is the ionCube UI module writing to
MariaDB: **extensions, trunks, outbound_routes, inbound_route (native),
ivr, ring_group, time_conditions, classes_of_service, music_on_hold,
feature_code, emergency_numbers, device_profiles, cid_management.** **[proven by
absence of create/update/delete PHP]** Writing these directly = replicating the
config generator's invariants by hand. **[unsafe — generator is ionCube]**

### (d) Generated config paths (output, never edit by hand)
`/etc/asterisk/vitalpbx/{pjsip,extensions,queues,voicemail,iax}__*.conf` — fully
regenerated by Apply Changes. Hand-edits are overwritten. **[proven — generation
headers; VitalPBX workflow]**

### (e) AstDB runtime overlay paths (Connect-owned, the proven-safe write surface)
`connect/t_<slug>/*`, `connect/didmap/<e164>/*`, `connect/pbx_tenant_map/<id>/*`,
`connect/system/*` via telephony `DBPut`. This **does not touch any `ombu_*`
table or generated config** — it is read by Connect's hand-installed shared
dialplan contexts at call time. **[proven — prior investigation,
`telephony.ts:589-659`]**

---

## 6. Unsafe Assumptions from the Previous Plan

Re-evaluating `docs/pbx/connect-pbx-control-plane-plan.md` against this evidence:

| Prior claim | Verdict | Correction |
|-------------|---------|------------|
| "Extensions: no REST write path (PBX side)" | **weakened** | The *extension object* (`ombu_extensions`) still has no REST create. **But `devices/create.php` exists** — a device/SIP endpoint may be creatable via REST. Device ≠ extension; untested. |
| "SIP creds live in `ombu_pjsip_devices`" | **disproven (partly)** | The secret lives in **`ombu_devices.secret` (plaintext)**. `ombu_pjsip_devices` holds only codecs/dtmf/max_contacts/permit. |
| "Trunks / outbound routes / IVRs / ring groups: no REST write path" | **confirmed** | No `create/update/delete.php` exists for any of them. Direct-DB only. |
| "Tenant create via REST is medium risk, documented" | **confirmed (endpoint) but weakened (usefulness)** | The endpoint exists, but a *functional* tenant needs COS, device profiles, extensions, devices, destinations, routes — **none of which have a REST path**. Creating a tenant record ≠ provisioning a working tenant. |
| "Inbound routes: indirect (flip `destination_id`) via helper" | **confirmed** | `ombu_inbound_routes.destination_id` flip via the snapshotted helper is the only native-write Connect does, and it only UPDATEs one column. |
| "Time conditions: use Connect overlay; no native write" | **confirmed** | Native `ombu_time_conditions` requires `time_group_id` (NOT NULL) + destinations; no REST path. |
| "MOH classes: AstDB assignment + file sync" | **confirmed** | `ombu_music_groups` rows are not REST-writable; Connect only assigns class via AstDB + syncs files. |
| "Queues: REST CRUD" | **confirmed but flagged** | Endpoints exist; queue rows reference extensions/destinations/recordings whose ids must be valid — untested at scale. |
| "Connect can be control plane via overlay" | **confirmed** | Overlay remains the only proven-safe write surface for routing/IVR/MOH. |
| Apply/reload model | **newly proven** | `ombu_queued_changes` + `apply_changes` per tenant + scoped reloads. Previously described only at the overlay level. |
| Emergency/911 "do not touch" | **confirmed + reinforced** | Dedicated tables (`ombu_emergency_*`) tied to trunks + `shared_trunks` setting; no REST; critical risk. |

---

## 7. Revised Recommendation

### What Connect can control today (evidence-backed)
- **Tenant lifecycle records + apply** via REST (`tenants.*`, `apply_changes`).
- **Queue CRUD** via REST (with post-apply verification).
- **DID inbound destination** via REST `tenants.addInboundNumbers` and/or the
  snapshotted inbound-route helper (single-column flip).
- **Routing / IVR / MOH / hold behaviour** via the Connect AstDB overlay.
- **Voicemail message** delete/mark; **codes** CRUD.
- **Read inventory** of all native objects (REST read + read-only `ombutel` SQL).

### What Connect might control later (requires lab proof first)
- **Device/SIP endpoint creation** via `devices/create.php` — *if* the §8 lab
  test proves payload, dependency requirements (extension must pre-exist?), and
  that it correctly queues + regenerates config.
- **Extension provisioning** — only via a future, separately-reviewed PBX-host
  helper that replicates VitalPBX's create semantics (COS link, device, voicemail,
  queue-change, apply) OR if a write endpoint is discovered/confirmed. Currently
  **no proven path.**

### What must NOT be automated until proven
- Direct `ombu_*` writes for extensions, trunks, outbound/inbound routes (native),
  IVRs, ring groups, time conditions, COS, feature codes, caller-ID management.
- **Anything touching `ombu_emergency_*` / 911 / `shared_trunks`.**
- Any caller-ID / CNAM / STIR-SHAKEN change (carrier-facing identity).

### What live non-production test is needed
The §8 experiment. Specifically, the highest-value unknowns to resolve are:
1. Does `devices/create.php` work, and what does it require/regenerate?
2. What exact `ombu_*` rows + `ombu_queued_changes` entries does the VitalPBX UI
   write when creating one extension, one ring group, one IVR, one inbound route,
   one outbound route — and what config files change on Apply?
3. How are `ombu_destinations` rows allocated when you point a route at an IVR?

---

## 8. Next Test Plan (lab-only, non-production, read/snapshot/diff)

**Goal:** observe exactly which DB rows, config files, and AstDB keys VitalPBX
changes when a human creates each object **through the VitalPBX GUI** on a
disposable lab box. **No production system. No Connect writes. No automation.**
This is pure observation to convert "[inferred]" into "[proven]".

### Preconditions
- A **dedicated lab VitalPBX VM** (snapshot the whole VM first). Never the prod
  host (`vmi…contaboserver.net`).
- Shell access to the lab box only.

### Snapshot tooling (read-only)
For each step, capture three snapshots labelled `before`/`after`:

```bash
# 1. DB snapshot (structure-stable, data only, ombu_* tables)
mysqldump --no-create-info --skip-extended-insert --order-by-primary \
  ombutel > /root/lab/db_<step>_<phase>.sql        # read-only dump

# 2. Generated Asterisk config snapshot
tar -czf /root/lab/conf_<step>_<phase>.tgz /etc/asterisk/vitalpbx/

# 3. AstDB snapshot
asterisk -rx "database show" > /root/lab/astdb_<step>_<phase>.txt

# 4. Pending-changes snapshot (the apply queue)
mysql ombutel -e "select * from ombu_queued_changes" \
  > /root/lab/queue_<step>_<phase>.txt
```

Diff with `diff -u before after` for each artifact. None of these commands write.

### Experiment sequence (each = snapshot → manual GUI create → snapshot → diff → **Apply Changes** → snapshot → diff)

1. **Tenant** — create one test tenant `LAB1` in the GUI.
   - Diff DB: expect `ombu_tenants` (+ default `ombu_tenant_settings`, COS,
     device profiles auto-seeded?). Record every table touched.
   - Diff config: expect new `*__50-<id>-*.conf` skeletons after Apply.
2. **Extension** — create one extension (e.g. `1001`) under `LAB1`.
   - Diff DB: confirm `ombu_extensions` + the **required `class_of_service_id`**
     value, `ombu_extensions_vm`, `ombu_devices` (+`ombu_pjsip_devices`), and the
     `ombu_queued_changes` rows added.
   - Diff config: confirm the new `[T<id>_1001]` endpoint/auth/aor in
     `pjsip__50-<id>-extensions.conf` and the dialplan context after Apply.
   - Record the **plaintext `secret`** location and how it maps to `password=`.
3. **Ring group** — create one ring group with the extension as a member.
   - Diff DB: `ombu_ring_groups` + `ombu_ring_group_members` + the
     `ombu_destinations` row created for it (capture `category_id`, `module_id`,
     `index`).
4. **IVR** — create one IVR with one entry pointing at the ring group.
   - Diff DB: `ombu_ivrs` + `ombu_ivr_entries`; capture how the entry's
     `destination_id` resolves to the ring group's destination.
   - Note the required `class_of_service_id` and `welcome_msg_id` (recording).
5. **Inbound route** — create one inbound route (DID) pointing at the IVR.
   - Diff DB: `ombu_inbound_routes.{did,destination_id,cos_id}`; capture the
     destination row for the IVR.
6. **Outbound route** — create one outbound route with a (lab) trunk member.
   - Diff DB: `ombu_outbound_routes` + `ombu_outbound_route_members` (trunk) +
     `ombu_outbound_route_patterns` + `ombu_ars_members`.
7. **(Optional, observe-only) `devices/create.php`** — if the lab has API
   access, issue **one** `devices/create.php` call **for an already-existing lab
   extension** and snapshot/diff DB + config to learn its payload and side
   effects. Do **not** test on prod; do **not** test extension creation via API
   blindly.

### Deliverable of the test
A `docs/pbx/vitalpbx-native-write-observations.md` table:
`object → exact ombu_* rows inserted → ombu_destinations row shape →
ombu_queued_changes entries → config files regenerated → reload command`.
That artifact is the prerequisite for *any* future "wrap a native write" work.

### Hard constraints for the test
- Lab VM only; VM snapshot before starting; revert after.
- All capture commands are read-only (`mysqldump`, `tar`, `database show`,
  `select`). No `INSERT`/`UPDATE`/`DELETE` by hand.
- One object per step; snapshot between each; never batch.
- Do **not** create emergency numbers / 911 / shared trunks in the test.

---

## Revised Go / No-Go

- **NO-GO** on Connect programmatically creating or mutating native VitalPBX
  objects via **direct `ombutel` writes** — the create logic, ID allocation,
  `ombu_destinations` resolution, and config generation are all ionCube and
  unproven; direct writes risk DB-vs-runtime drift and broken future
  `apply_changes`. **[evidence-backed]**
- **NO-GO** on using `devices/create.php` (or any `route.php` verb) in production
  until the §8 lab test establishes payload, dependencies, and apply behaviour.
  Its existence is proven; its safety is **not**. **[evidence-backed]**
- **CONDITIONAL-GO (already in production, keep)** on the **proven-safe surface**:
  tenant lifecycle + `apply_changes`, queue CRUD, tenant inbound-number routing,
  the snapshotted inbound-route helper (single-column flip), voicemail
  delete/mark, and the **AstDB overlay** for routing/IVR/MOH/hold. These do not
  require direct native-object writes.
- **HARD NO-GO** on automating trunks, outbound/native-inbound routes, caller-ID/
  CNAM/STIR-SHAKEN, and **emergency/911** under any path until each has a
  dedicated, separately-reviewed proof. **[evidence-backed]**

**Bottom line:** native object provisioning is **not safe to automate today**.
The only honest next step is the lab observation in §8 — convert inference into
proof, object by object, before writing a single native row.
