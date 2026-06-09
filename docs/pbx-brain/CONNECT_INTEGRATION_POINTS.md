# Connect Integration Points

Evidence from Connect dialplan overlays, AstDB usage, AMI/ARI config, VitalPBX API surface, and Connect diagnostic SQL in `docs/pbx-brain/extracted-useful/`.

---

## 1. Asterisk dialplan overlays (Tier A)

### Primary file

`etc-asterisk/asterisk/extensions__60_custom.conf`

Header states: auto-installed by `install-connect-wake-dialplan.sh`; do not hand-edit.

Included from `etc-asterisk/asterisk/extensions.conf` line 3.

### Connect contexts defined

| Context | Lines (approx.) | Role |
|---------|-----------------|------|
| `connect-tenant-router` | 8–32 | Option A router: DID → tenant slug, MOH, mode → destination via AstDB |
| `connect-default-fallback` | 34–39 | Playback `vm-goodbye` when routing fails |
| `connect-tenant-ivr` | 41–172 | Phase 2 IVR: prompts, digits 0–9, timeout/invalid exits |
| `connect-option-router` | 174–188 | Per-digit option routing via `opt_${DIGIT}` AstDB keys |
| `connect-exit-router` | 190–205 | IVR exit destinations by `EXIT_TYPE` |
| `connect-dial-with-wake` | 207–235 | Push-wake probe + `curl` POST before dial |
| `connect-hold-announce` | 237–250 | Hold announcement loop |
| `connect-entry` | 259–266 | DID entry → resolve slug → `connect-tenant-ivr` |

### Bridge from VitalPBX custom app

`extensions__60_custom.conf` lines 253–257 — context `[T21_app-custom-application]`:

```
exten => 8001,1,NoOp(Connect bridge — sending DID ${CALLERID(dnid)} to connect-entry)
 same => n,Set(__CONNECT_DID=${CALLERID(dnid)})
 same => n,Goto(connect-entry,s,1)
```

### Runtime confirmation

`asterisk-cli/dialplan-show.txt` cites `extensions__60_custom.conf` for `connect-tenant-router`, `connect-tenant-ivr`, `connect-default-fallback`, and `connect-entry` transitions.

---

## 2. MOH enforcement overlay

**File:** `etc-asterisk/asterisk/extensions__65_connect_tenant_moh.conf`

Header: auto-installed by `scripts/pbx/install-connect-tenant-moh-dialplan.sh`.

Included at end of `extensions__60_custom.conf` line 269.

### Contexts

| Context | Role |
|---------|------|
| `sub-connect-tenant-moh` | Resolves tenant MOH class; sets `CHANNEL(musicclass)` |
| `connect-tenant-moh-connect-shim` | Shim included from VitalPBX `before-connecting-call-hook` contexts |

`dialplan-show.txt` lines 375–393 reference `connect-tenant-moh-connect-shim` and `sub-connect-tenant-moh`.

### AstDB keys (from file header comments, lines 6–12)

```
connect/pbx_tenant_map/<numeric-vital-tenant-id>/slug
connect/pbx_tenant_map/<numeric-vital-tenant-id>/moh_class
connect/t_<slug>/moh_class
connect/t_<slug>/active_moh_class
```

Comment states keys are **written by Connect API** on MOH publish + rollback.

---

## 3. AstDB key catalog

All keys below are referenced in `extensions__60_custom.conf` and/or `extensions__65_connect_tenant_moh.conf`.

### System-wide

| Key | File:line | Purpose |
|-----|-----------|---------|
| `connect/system/wake_api_url` | `extensions__60_custom.conf:221` | Wake HTTP endpoint |
| `connect/system/wake_wait_secs` | `extensions__60_custom.conf:223` | Post-wake wait (default 6) |

### Per-DID

| Key | Purpose |
|-----|---------|
| `connect/didmap/${EXTEN}/tenant` | Override `TENANT_SLUG` from DNID |
| `connect/didmap/${EXTEN}/moh_class` | Per-DID MOH override |

### Per-tenant slug (`FAMILY=connect/t_${TENANT_SLUG}`)

| Key | Purpose |
|-----|---------|
| `${FAMILY}/mode` | Active routing mode |
| `${FAMILY}/dest_${MODE}` | Destination for mode |
| `${FAMILY}/moh_class`, `active_moh_class` | MOH class |
| `${FAMILY}/active_prompt` | IVR greeting ref |
| `${FAMILY}/active_prompt_invalid` | Invalid digit prompt |
| `${FAMILY}/active_prompt_timeout` | Timeout prompt |
| `${FAMILY}/active_prompt_retry` | Retry prompt |
| `${FAMILY}/timeout_seconds` | Digit wait (default 7) |
| `${FAMILY}/max_retries` | IVR retry cap (default 3) |
| `${FAMILY}/direct_dial` | Direct-dial enable |
| `${FAMILY}/dest_timeout`, `dest_timeout_type` | Timeout exit |
| `${FAMILY}/dest_invalid`, `dest_invalid_type` | Invalid exit |
| `${FAMILY}/opt_${DIGIT}/dest`, `opt_${DIGIT}/type` | Menu option routing |
| `${FAMILY}/hold_announce`, `hold_repeat` | Hold loop |
| `${FAMILY}/pbx_tenant_id` | Numeric Vital tenant id for endpoint naming |
| `${FAMILY}/pbx_tenant_code` | Wake payload `pbxVitalTenantId` |

### Per-numeric Vital tenant id

| Key | File |
|-----|------|
| `connect/pbx_tenant_map/${TENANT_ID}/slug` | `extensions__65_connect_tenant_moh.conf:50` |
| `connect/pbx_tenant_map/${TENANT_ID}/moh_class` | `extensions__65_connect_tenant_moh.conf` (resolver body) |

---

## 4. Push-wake HTTP integration

**File:** `extensions__60_custom.conf` lines 207–235 (`connect-dial-with-wake`)

Flow evidenced:

1. Read `PBX_TENANT_ID` from `connect/t_${TENANT_SLUG}/pbx_tenant_id`
2. Probe `PJSIP_DIAL_CONTACTS` for `T${PBX_TENANT_ID}_${WAKE_EXT}` and `..._${WAKE_EXT}_1`
3. If no contacts, `curl -X POST` to `WAKE_URL` with JSON payload containing `pbxCallId`, `pbxVitalTenantId`, `extensionNumber`, `fromNumber`, `fromDisplay`
4. Header `x-cdr-secret: ${WAKE_SECRET}` (value `REDACTED` in archive)
5. `Wait(${WAKE_WAIT})` then `Goto(${DIAL_TARGET})`

---

## 5. AMI integration

### Config

**File:** `etc-asterisk/asterisk/manager.conf`

- Includes `#include vitalpbx/manager__*.conf`
- Connect-specific user `[connectcommsgefenu]`:
  - `permit = 45.14.194.179/255.255.255.255`
  - `read` / `write` classes include `system,call,agent,user,originate,dialplan,...`

### Runtime users

**File:** `asterisk-cli/ami-users.txt`

```
astmanager
connectcommsgefenu
```

### VitalPBX UI module

`www/modules/astmanager_users/` — `ami_user.php`, `Asterisk/Configurations.php` (ionCube-encoded).

Compiled fragments: `etc-asterisk/asterisk/vitalpbx/manager__50-*-users.conf` (25 files).

---

## 6. ARI integration

### Config

**File:** `etc-asterisk/asterisk/ari.conf`

- `#include vitalpbx/ari__*.conf`
- User `[connectcomms]`, `type=user`, `read_only=no`

### Runtime users

**File:** `asterisk-cli/ari-users.txt`

```
connectcomms  (read_only: No)
vitalpbx      (read_only: No)
```

Compiled fragments: `etc-asterisk/asterisk/vitalpbx/ari__*.conf` (2 files).

### PHP helpers (ionCube-encoded)

`www/includes/asterisk/ARI.php`, `www/includes/asterisk/AGI.php`

---

## 7. VitalPBX REST API (`api_v2`)

**Directory:** `vitalpbx/vitalpbx/www/api_v2/`

Connect-relevant endpoints (filename evidence):

| Endpoint | Operations | Likely use |
|----------|------------|------------|
| `tenants/` | create, delete, read, route | Tenant CRUD |
| `trunks/` | read | Trunk inventory |
| `queues/` | create, delete, read, route | Queue management |
| `extensions/` | read | Extension inventory |
| `outbound_routes/` | read | Outbound routing |
| `destinations/` | read | Destination type catalog |
| `devices/` | create, read, route | Endpoint provisioning |
| `vpbx_connect/` | read | Connect addon read surface |
| `agents/` | read | Queue agents |

`routes.php` is ionCube-encoded — **HTTP paths and auth rules are not readable from extract**.

---

## 8. VitalPBX Connect addon

### Menu/modules migration

**File:** `migrations/vpbx-connect/20220710.2.add_modules.sql`

- Registers modules `mobile_settings`, `mobile_devices`
- Inserts menu `menu.vpbx_connect` under `menu.pbx`

### Mobile devices table

**File:** `migrations/vpbx-connect/20220710.3.add_mobile_dev_tbl.sql` — `ombu_mobile_devices` with `tenant_id` FK.

### API endpoint

**File:** `www/api_v2/vpbx_connect/read.php` — present; ionCube-encoded body.

---

## 9. Connect PostgreSQL diagnostic queries

These files document **which Connect tables** participate in PBX integration. No result rows are in the extract.

| File | Tables queried |
|------|----------------|
| `backups/tmp_pbx_tenant.sql` | `PbxTenantDirectory`, `PbxExtensionHint` |
| `backups/check_pbx.sql` | `PbxInstance`, `TenantPbxLink`, `ConnectCdr` |
| `backups/check_links.sql` | `TenantPbxLink`, `Tenant`, `PbxInstance` |
| `backups/verify_isolation.sql` | `TenantPbxPrompt`, `Tenant` |

### Example linkage query

**File:** `backups/check_links.sql`

```sql
SELECT l."pbxTenantId", l."tenantId", t.name AS connect_tenant_name, l.status
FROM "TenantPbxLink" l ...
WHERE l."pbxTenantId" ~ '^[0-9]+$';
```

---

## 10. WebRTC / WebSocket

| Evidence | File |
|----------|------|
| WS/WSS transports live | `asterisk-cli/pjsip-transports.txt` |
| Default WebRTC PJSIP profile DDL | `migrations/20200714.1.webrtc_profile.sql` |
| SIP WebSocket disabled | `migrations/20200929.1.pjsip_ws.sql` |
| WebSocket channel driver config | `etc-asterisk/asterisk/chan_websocket.conf` |
| WebSocket client fragment | `etc-asterisk/asterisk/vitalpbx/websocket_client__10-realtime-agents.conf` |

---

## 11. IVR prompt file resolution

**File:** `extensions__60_custom.conf` lines 71–72

Connect IVR checks prompt files at:

```
/var/lib/asterisk/sounds/${GREETING}.ulaw
/var/lib/asterisk/sounds/${GREETING}.wav
```

Prompt refs come from AstDB `${FAMILY}/active_prompt` etc. — aligned with Connect `TenantPbxPrompt` model in `verify_isolation.sql` (storage keys `tenants/%`), though that linkage is **not explicitly wired in dialplan text**.

---

## Integration map (summary)

```
Inbound DID
  → VitalPBX inbound route / custom app (T21_app-custom-application)
  → connect-entry (AstDB didmap)
  → connect-tenant-ivr (AstDB prompts + options)
  → connect-option-router / connect-exit-router
  → connect-dial-with-wake (AstDB + HTTP wake)
  → VitalPBX PJSIP endpoint T{n}_{ext}

MOH on bridge
  → connect-tenant-moh-connect-shim
  → sub-connect-tenant-moh (AstDB pbx_tenant_map + t_{slug})

Connect app ↔ PBX metadata
  → PostgreSQL: PbxTenantDirectory, TenantPbxLink, PbxExtensionHint, TenantPbxPrompt
  → AstDB: connect/t_{slug}/*, connect/pbx_tenant_map/*

Optional control plane
  → AMI: connectcommsgefenu
  → ARI: connectcomms
  → api_v2: tenants, queues, trunks, vpbx_connect, ...
```

---

## Related documents

- `TENANT_MODEL.md` — `T{n}_` naming and tenant tables
- `PBX_ARCHITECTURE.md` — full stack layers
- `RISKS_AND_LIMITATIONS.md` — unreadable PHP, missing dumps

*Generated from `extracted-useful/` only.*
