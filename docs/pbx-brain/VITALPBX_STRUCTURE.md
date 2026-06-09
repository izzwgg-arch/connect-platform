# VitalPBX Structure

Evidence from `docs/pbx-brain/extracted-useful/pbx-full-brain-20260609-063057/vitalpbx/`.

---

## Install path

All VitalPBX application files in the extract live under:

```
vitalpbx/vitalpbx/
  migrations/
  www/
    api_v2/
    modules/
    includes/
```

(200 files total in `vitalpbx/` subtree per extract listing.)

---

## UI modules extracted (82 files)

The plan-selected modules under `www/modules/`:

| Module directory | Files | Notable paths | Source |
|------------------|------:|---------------|--------|
| `tenants/` | 11 | `tenants.php`, `Tabs/General.php`, `Tabs/Settings.php`, `Tabs/Routing.php`, `DIDNumber.php` | module glob |
| `trunks/` | 10 | `trunks.php`, `Tabs/General.php`, `Tabs/Rules.php`, `Tabs/Advanced.php` | module glob |
| `ivr/` | 9 | `ivr.php`, `ivr_entry.php`, `Tabs/General.php`, `Tabs/Entries.php`, `Asterisk/DialPlan.php` | module glob |
| `queues/` | 12 | `queues.php`, `Tabs/General.php`, `Tabs/Others.php`, `Tabs/Helper.php` | module glob |
| `time_conditions/` | 9 | `time_conditions.php`, `time_condition.php`, `Tabs/General.php` | module glob |
| `inbound_route/` | 7 | `inbound_route.php`, `Asterisk/DialPlan.php`, `Tabs/General.php` | module glob |
| `dynamic_routing/` | 9 | (module PHP + tabs) | module glob |
| `pjsip_endpoints/` | — | (included in 82-file module set) | module glob |
| `pjsip_settings/` | — | (included in 82-file module set) | module glob |
| `pjsip_transports/` | — | (included in 82-file module set) | module glob |
| `astmanager_users/` | 8 | `astmanager_users.php`, `ami_user.php`, `Asterisk/Configurations.php` | module glob |
| `extensions/` | — | `Tabs/Voicemail.php`, `Tabs/Routing.php`, `Validations.php` | module glob |

**Module → dialplan compilation:** Several modules contain `Asterisk/DialPlan.php` (e.g. `inbound_route/Asterisk/DialPlan.php`, `ivr/Asterisk/DialPlan.php`). These files are ionCube-encoded in the extract (first line: `<?php //002cd` + ionCube loader message).

---

## REST API (`www/api_v2/` — 61 files)

Entry points:

| File | Role |
|------|------|
| `api.php` | API bootstrap |
| `routes.php` | Route table (ionCube-encoded) |
| `index.php`, `Get.php` | API infrastructure |

### Endpoints and operations (from filenames only)

| Endpoint | PHP operations present |
|----------|------------------------|
| `tenants/` | `create.php`, `delete.php`, `read.php`, `route.php` |
| `trunks/` | `read.php` |
| `queues/` | `create.php`, `delete.php`, `read.php`, `route.php` |
| `extensions/` | `read.php` |
| `outbound_routes/` | `read.php` |
| `route_selections/` | `read.php` |
| `destinations/` | `read.php` |
| `devices/` | `create.php`, `read.php`, `route.php` |
| `device_profiles/` | `read.php`, `route.php` |
| `agents/` | `read.php` |
| `users/` | `read.php` |
| `classes_of_services/` | `read.php` |
| `cdr/` | `read.php` |
| `core/` | `create.php`, `read.php` |
| `vpbx_connect/` | `read.php` |
| `voicemail/` | `delete.php`, `update.php` |
| `auth_codes/` | `create.php`, `delete.php`, `read.php`, `resource.php`, `route.php` |
| `customer_codes/` | `create.php`, `delete.php`, `read.php`, `resource.php`, `route.php` |
| `ai_api_keys/` | `create.php`, `delete.php`, `read.php`, `resource.php`, `route.php` |
| `account_codes/` | `read.php` |
| `conferences/` | `read.php` |
| `parking_lots/` | `read.php` |
| `phonebooks/` | `read.php` |
| `roles/` | `read.php` |
| `virtual_faxes/` | `create.php`, `read.php`, `route.php` |
| `sms/` | `route.php`, `sms.php` |
| `whatsapp/` | `route.php`, `wa.php` |
| `pms/` | `APIResponses.php`, `PMS.php`, `route.php` |

(Source: `vitalpbx/vitalpbx/www/api_v2/` directory listing.)

`routes.php` and most `*.php` handler bodies are ionCube-encoded — **endpoint inventory is from filenames only**.

---

## Shared includes (`www/includes/`)

### Extracted subset

| Path | Files | Notes |
|------|------:|-------|
| `includes/asterisk/` | 35 | Asterisk integration helpers |
| `includes/ivr.php` | 1 | ionCube-encoded |
| `includes/queue.php` | 1 | ionCube-encoded |
| `includes/ModulesDB.php` | 1 | ionCube-encoded |

### Readable structure in `includes/asterisk/`

Non-exhaustive file list (filenames evidence layout):

- `Manager.php`, `ARI.php`, `AGI.php` — control plane clients (ionCube-encoded)
- `ConfigurationFile.php`, `Configurations.php`, `Driver.php` — config generation
- `DialPlan/DialPlan.php`, `DialPlan/Context.php`, `DialPlan/Destination.php`, `DialPlan/Extension.php`, `DialPlan/TimeCondition.php`
- `DialPlan/Applications/*.php` — `Answer`, `Dial`, `Background`, `Set`, `RedirectTo`, `RedirectIfTime`, etc.

All sampled `DialPlan/*.php` files open with ionCube loader stubs.

---

## Migrations extracted

### Base schema (`20191218.*`)

| File | Content |
|------|---------|
| `20191218.1.vitalpbx.sql` | Bootstrap |
| `20191218.2.asterisk.sql` | Asterisk-related schema |
| `20191218.3.tables.sql` | Full `ombutel` `CREATE TABLE` set |
| `20191218.4.data.sql` | Seed `INSERT` rows |
| `20191218.5.1.core.sql` | Core additions |
| `20191218.6.collations.php` | Collation migration (PHP) |

Location: `vitalpbx/vitalpbx/migrations/`

### Multi-tenant (`migrations/multi-tenant/` — 8 files)

| File | Evidence |
|------|----------|
| `multi_tenant.sql` | Creates `tenant_admin` role; grants on modules where `multi_tenant='yes'` |
| `mt.1.dids_tbl.sql` | `CREATE TABLE ombu_tenant_dids (tenant_id, did)` |
| `mt.2.migrate_dids.php` | DID migration script |
| `mt.3.remove_deprecated_param.sql` | Parameter cleanup |
| `mutli_tenant.20230317.1.update-menu.sql` | Menu update |
| `mutli_tenant.20230317.2.DID_management.sql` | DID management DDL |
| `mutli_tenant.20230317.3.mt_dids_desc.sql` | DID description column |
| `mutli_tenant.20250626.1.shared_trunks.sql` | Renames `emergency_trunks` → `shared_trunks` in `ombu_tenant_settings` |

### VitalPBX Connect addon (`migrations/vpbx-connect/` — 3 files)

| File | Evidence |
|------|----------|
| `20220710.2.add_modules.sql` | Adds `mobile_settings`, `mobile_devices` modules; menu label `menu.vpbx_connect` |
| `20220710.3.add_mobile_dev_tbl.sql` | `CREATE TABLE ombu_mobile_devices` |
| `20221106.2.vpbx_connect_notifications_tpl.sql` | Notification templates (not fully read; file present) |

### WebRTC / PJSIP WS

| File | Evidence |
|------|----------|
| `20200714.1.webrtc_profile.sql` | Inserts `Default WebRTC Profile` with `webrtc='yes'`, `transport='wss'`, ICE/DTLS fields |
| `20200929.1.pjsip_ws.sql` | Sets `ombu_settings.websocket_enabled='no'` on `sip_settings` module |

---

## Config generation → Asterisk

VitalPBX modules with `Asterisk/DialPlan.php` or `Asterisk/Configurations.php` compile into `etc-asterisk/asterisk/vitalpbx/` fragments (see `PBX_ARCHITECTURE.md`).

Example compiled outputs present in extract:

- `extensions__50-*-dialplan.conf` (54 files)
- `pjsip__50-*-extensions.conf`, `pjsip__50-*-trunks.conf`, `pjsip__40-1-profiles.conf`
- `queues__50-*-main.conf` (24 files)
- `manager__50-*-users.conf` (25 files)

---

## Default seed tenant

`20191218.4.data.sql` line 3:

```sql
insert into `ombu_tenants` values (1,'vitalpbx','VitalPBX','yes','dummy',null,'yes');
```

This is **installer seed data**, not evidence of production tenant rows.

---

## Not in extract (per plan exclusions)

The following VitalPBX subtrees were intentionally **not** extracted:

- `provisioning/` (1,590 paths in full archive per plan)
- `i18n/` (1,663 paths)
- `static/` (audio/assets)
- `firewall_zones/`
- `www/includes/components/` (400 paths)
- Most incremental `backups/*.sql` duplicates

---

## Related documents

- `TENANT_MODEL.md` — `ombu_tenants` and tenant-scoped tables
- `CONNECT_INTEGRATION_POINTS.md` — `vpbx_connect` API, Connect dialplan
- `RISKS_AND_LIMITATIONS.md` — ionCube readability limits

*Generated from `extracted-useful/` only.*
