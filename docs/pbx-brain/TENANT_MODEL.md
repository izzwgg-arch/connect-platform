# Tenant Model

Evidence from schema SQL, migrations, compiled Asterisk configs, and CLI output in `docs/pbx-brain/extracted-useful/`.

---

## VitalPBX core tenant table

**File:** `vitalpbx/vitalpbx/migrations/20191218.3.tables.sql` (duplicate: `backups/20191218.3.tables.sql`)

```sql
create table `ombu_tenants` (
  `tenant_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) not null,
  `description` varchar(255) default null,
  `default` enum('yes','no') not null default 'no',
  `path` char(16) not null,
  `prefix` varchar(255) default null,
  `enabled` enum('yes','no') not null default 'no',
  primary key (`tenant_id`),
  unique key `path` (`path`),
  unique key `name` (`name`)
);
```

### Column semantics (from DDL only)

| Column | Type | Notes |
|--------|------|-------|
| `tenant_id` | `int unsigned` | Surrogate key; used in FKs and `T{id}_` Asterisk naming |
| `name` | `varchar(255)` | Unique tenant name |
| `path` | `char(16)` | Unique path segment |
| `prefix` | `varchar(255)` | Optional dial prefix |
| `default` | `yes/no` | Default tenant flag |
| `enabled` | `yes/no` | Enable flag |

---

## Tenant settings (key-value)

**File:** `20191218.3.tables.sql`

```sql
create table `ombu_tenant_settings` (
  `tenant_id` int(10) unsigned not null,
  `name` varchar(255) not null,
  `value` varchar(255) default null,
  unique key (`tenant_id`,`name`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);
```

**Migration evidence:** `mutli_tenant.20250626.1.shared_trunks.sql` renames setting `emergency_trunks` → `shared_trunks`:

```sql
update `ombu_tenant_settings` set `name` = 'shared_trunks' where `name` = 'emergency_trunks';
```

---

## Tenant DIDs

**File:** `migrations/multi-tenant/mt.1.dids_tbl.sql`

```sql
create table if not exists ombu_tenant_dids(
    `tenant_id` int unsigned not null,
    `did` varchar(255) not null,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);
```

Additional DID DDL: `mutli_tenant.20230317.2.DID_management.sql`, `mutli_tenant.20230317.3.mt_dids_desc.sql` (files present; not fully expanded in this doc).

UI module for tenants includes `tenants/DIDNumber.php` (file present in extract).

---

## Tenant ↔ user mapping

**File:** `20191218.3.tables.sql`

```sql
create table `ombu_tenants_users` (
    `user_id` int(10) unsigned not null,
    `tenant_id` int(10) unsigned not null,
    `default` enum('yes','no') not null default 'no',
    ...
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);
```

**File:** `multi_tenant.sql` — creates `tenant_admin` role scoped to seed tenant `name='vitalpbx'` and grants privileges on modules where `multi_tenant='yes'`.

---

## Tenant-scoped telephony entities

Tables below include `tenant_id` FK to `ombu_tenants` per `20191218.3.tables.sql`:

| Entity | Table | `tenant_id` column |
|--------|-------|-------------------|
| Time conditions | `ombu_time_conditions` | `tenant_id int unsigned default null` (line 462) |
| Trunks | `ombu_trunks` | via `ombu_tenant_trunks` association table (same file) |
| Inbound routes | `ombu_inbound_routes` | `tenant_id` FK (grep confirms column in DDL) |
| IVRs | `ombu_ivrs` | `tenant_id int unsigned default null` (line 1353) |
| Queues | `ombu_queues` | `tenant_id int unsigned default null` (line 1702) |
| Music on hold | `ombu_music_groups` | `tenant_id` (line 40) |

### Queue schema excerpt

**File:** `20191218.3.tables.sql` lines 1660–1717

Key fields: `extension`, `strategy`, `prefix`, `destination_id`, `ivr_id`, `tenant_id`.

### IVR schema excerpt

**File:** `20191218.3.tables.sql` lines 1334–1372

Key fields: `welcome_msg_id`, `timeout_destination_id`, `invalid_destination_id`, `tenant_id`.

---

## Runtime tenant index (`T{n}_` prefix)

Compiled Asterisk and CLI output use **numeric `tenant_id`** as a prefix.

### Queue names

**File:** `asterisk-cli/queue-show.txt`

| Queue name | Tenant index |
|------------|-------------|
| `T2_Q600` | 2 |
| `T8_Q750`, `T8_Q751`, `T8_Q752` | 8 |

Members reference `T8_queue-call-to-agents` and `T8_extension-hints` contexts.

### PJSIP endpoints

**File:** `services/asterisk-status.txt` (Jun 09 2026 log lines)

Examples: `T18_105`, `T11_103`, `T3_301`, `T2_111`, `T2_101`.

**File:** `extensions__60_custom.conf` lines 215–216

```
Set(EP_PRIMARY=T${PBX_TENANT_ID}_${WAKE_EXT})
Set(EP_SECONDARY=T${PBX_TENANT_ID}_${WAKE_EXT}_1)
```

`PBX_TENANT_ID` is read from AstDB `connect/t_${TENANT_SLUG}/pbx_tenant_id`.

### Per-tenant compiled dialplan

**Files:** `etc-asterisk/asterisk/vitalpbx/extensions__50-{n}-dialplan.conf`

The `{n}` segment aligns with `tenant_id` ordinals (e.g. `50-28`, `50-29` files coexist with `T8_*` queues in CLI output).

### MOH resolver tenant detection

**File:** `extensions__65_connect_tenant_moh.conf` lines 27–48

Reads channel context vars (`TRANSFER_CONTEXT`, `HINTS_CONTEXT`, etc.), extracts `T<digits>` prefix, falls back to numeric `ARG1`.

AstDB lookups:

- `connect/pbx_tenant_map/${TENANT_ID}/slug`
- `connect/pbx_tenant_map/${TENANT_ID}/moh_class`
- `connect/t_${slug}/moh_class`
- `connect/t_${slug}/active_moh_class`

---

## Connect-side tenant mapping (PostgreSQL)

The extract contains **diagnostic queries only** — no query results.

### `PbxTenantDirectory`

**File:** `backups/tmp_pbx_tenant.sql`

```sql
SELECT id, "vitalTenantId", "tenantSlug", "tenantCode", "displayName"
FROM "PbxTenantDirectory"
WHERE "pbxInstanceId" = 'cmmi7huxy0000qq3igj493o5q'
```

Maps Connect directory entries to VitalPBX tenant identifiers (`vitalTenantId`, `tenantCode`).

### `TenantPbxLink`

**File:** `backups/check_links.sql`

```sql
SELECT l."pbxTenantId", l."tenantId", t.name AS connect_tenant_name, l.status
FROM "TenantPbxLink" l
LEFT JOIN "Tenant" t ON t.id = l."tenantId"
WHERE l."pbxTenantId" ~ '^[0-9]+$'
```

`pbxTenantId` filtered to numeric strings — consistent with VitalPBX `ombu_tenants.tenant_id`.

### `PbxExtensionHint`

**File:** `backups/tmp_pbx_tenant.sql`

```sql
SELECT h."extensionNumber", h."connectTenantId", h."pbxTenantCode"
FROM "PbxExtensionHint" h
WHERE h."connectTenantId" = 'cmnlgnumi0000p9g6l7t1t0z7'
```

### `TenantPbxPrompt` (per-tenant audio catalog)

**File:** `backups/verify_isolation.sql`

Queries `"TenantPbxPrompt"` with `"tenantId"`, `"storageKey" LIKE 'tenants/%'`, and sample tenant IDs `cmnlgryp8001lp9pajhatv3t9`, `cmnlgryjk0003p9pabtu1z1oj`.

---

## Connect AstDB tenant family

**File:** `extensions__60_custom.conf`

Per-tenant AstDB family: `connect/t_${TENANT_SLUG}`

Keys referenced in extract:

| Key pattern | Used in |
|-------------|---------|
| `connect/didmap/${DNID}/tenant` | `connect-tenant-router`, `connect-tenant-ivr`, `connect-entry` |
| `connect/didmap/${DNID}/moh_class` | Same contexts |
| `connect/t_${TENANT_SLUG}/mode` | `connect-tenant-router` |
| `connect/t_${TENANT_SLUG}/dest_${MODE}` | `connect-tenant-router` |
| `connect/t_${TENANT_SLUG}/moh_class`, `active_moh_class` | Router, IVR, MOH |
| `connect/t_${TENANT_SLUG}/active_prompt*` | `connect-tenant-ivr` |
| `connect/t_${TENANT_SLUG}/opt_${DIGIT}/dest` | `connect-option-router` |
| `connect/t_${TENANT_SLUG}/pbx_tenant_id` | `connect-dial-with-wake` |
| `connect/t_${TENANT_SLUG}/pbx_tenant_code` | Wake payload |
| `connect/pbx_tenant_map/${TENANT_ID}/slug` | `extensions__65_connect_tenant_moh.conf` |

`TENANT_SLUG` is a channel variable set before entering Connect contexts (e.g. `connect-entry` sets `__TENANT_SLUG` from `connect/didmap/`).

---

## VitalPBX Connect mobile devices

**File:** `migrations/vpbx-connect/20220710.3.add_mobile_dev_tbl.sql`

```sql
create table `ombu_mobile_devices` (
 ...
 `tenant_id` int unsigned not null,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);
```

---

## Seed vs production data

| File | What it proves |
|------|----------------|
| `20191218.4.data.sql` | Default tenant `tenant_id=1`, `name='vitalpbx'`, `path='dummy'` |
| `tmp_pbx_tenant.sql`, `check_links.sql` | Connect **expects** numeric `pbxTenantId` and maps slugs/codes — no row data in extract |
| `queue-show.txt`, `asterisk-status.txt` | Production uses tenant indices 2, 8, 11, 18, 3 at minimum |

**No `mysqldump` or `SELECT` results from `ombutel` are in the extract.**

---

## Related documents

- `PBX_ARCHITECTURE.md` — layer overview
- `CONNECT_INTEGRATION_POINTS.md` — AstDB, wake API, AMI/ARI
- `RISKS_AND_LIMITATIONS.md` — missing live MariaDB rows

*Generated from `extracted-useful/` only.*
