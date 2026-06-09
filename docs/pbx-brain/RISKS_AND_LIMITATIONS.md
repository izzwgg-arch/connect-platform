# Risks and Limitations

Evidence gaps and constraints documented from `docs/pbx-brain/extracted-useful/` and `PBX_ARCHITECTURE_PLAN.md`. No speculation beyond what files show or fail to show.

---

## 1. No live MariaDB tenant/trunk/IVR/queue data

### What is present

| File | Content type |
|------|--------------|
| `vitalpbx/vitalpbx/migrations/20191218.3.tables.sql` | `CREATE TABLE` DDL only |
| `vitalpbx/vitalpbx/migrations/20191218.4.data.sql` | Seed `INSERT` (default `vitalpbx` tenant, module list) |
| `backups/20191218.3.tables.sql` | Duplicate DDL |

### What is absent

- No `mysqldump` of `ombutel`
- No `SELECT` output from VitalPBX MariaDB
- `backups/tmp_pbx_tenant.sql` contains PostgreSQL queries against `"PbxTenantDirectory"` — **not** a VitalPBX dump

**Impact:** Cannot determine production tenant names, DID assignments, trunk credentials, IVR menus, or queue members from this extract alone.

`PBX_ARCHITECTURE_PLAN.md` section 7 lists this as verified absent in the parent archive.

---

## 2. ionCube-encoded PHP

### Files confirmed ionCube-encoded (first line `<?php //002cd`)

| Path | Implication |
|------|-------------|
| `vitalpbx/vitalpbx/www/api_v2/routes.php` | HTTP routes, auth, request parsing not readable |
| `vitalpbx/vitalpbx/www/api_v2/vpbx_connect/read.php` | Connect addon API behavior not readable |
| `vitalpbx/vitalpbx/www/includes/ivr.php` | IVR business logic not readable |
| `vitalpbx/vitalpbx/www/includes/queue.php` | Queue business logic not readable |
| `vitalpbx/vitalpbx/www/includes/ModulesDB.php` | DB access layer not readable |
| `vitalpbx/vitalpbx/www/includes/asterisk/Manager.php` | AMI client implementation not readable |
| `vitalpbx/vitalpbx/www/includes/asterisk/DialPlan/DialPlan.php` | Dialplan compiler not readable |
| `vitalpbx/vitalpbx/www/modules/tenants/Tabs/General.php` | Tenant UI logic not readable |
| `vitalpbx/vitalpbx/www/modules/inbound_route/Asterisk/DialPlan.php` | Inbound route compilation not readable |

**Impact:** Module and API **structure** (directories, filenames) is documented; **implementation** is not auditable from extract.

---

## 3. Connect application source not included

The extract contains:

- Asterisk dialplan overlays (`extensions__60_custom.conf`, `extensions__65_connect_tenant_moh.conf`)
- PostgreSQL diagnostic SQL (`backups/tmp_pbx_tenant.sql`, `check_pbx.sql`, `check_links.sql`, `verify_isolation.sql`)

It does **not** contain Connect API route handlers, Prisma models, or services that write AstDB keys.

**Impact:** AstDB key names are evidenced in dialplan; **who writes them** must be traced in Connect repo separately.

---

## 4. Compiled Asterisk configs are snapshots, not source of truth

`etc-asterisk/asterisk/vitalpbx/` contains 155 generated fragments (`extensions__*`, `pjsip__*`, `queues__*`, etc.).

Limitations:

- Reflect export-time state only (`services/asterisk-status.txt` dated Jun 09 2026)
- May include stale `.bak` siblings in parent archive (excluded from extract per plan; current `.conf` files included)
- Tenant index in filenames (`50-28`, etc.) must be correlated with live `tenant_id` — not fully mapped in extract

**Impact:** Use for debugging compiled output; schema + VitalPBX modules are maintainable sources.

---

## 5. No voicemail or call recording audio

Extract file scan found **zero** `.wav`, `.mp3`, `.png` files.

Voicemail-related content in extract is **configuration only**:

- `etc-asterisk/asterisk/voicemail.conf`
- `etc-asterisk/asterisk/vitalpbx/voicemail__*.conf`
- `www/modules/extensions/Tabs/Voicemail.php` (module file present)
- `www/api_v2/voicemail/update.php`, `delete.php`

`PBX_ARCHITECTURE_PLAN.md` section 3 documents 181 `.wav` files in full archive under `static/` — **excluded** from extract.

---

## 6. Log index without log bodies

**File:** `log-index/log-files.txt`

Lists paths such as `/var/log/asterisk/full`, `/var/log/nginx/access.log.*.gz`, `/var/log/vitalpbx/authentications.log`.

No log file contents are bundled.

---

## 7. Diagnostic SQL without results

All Connect SQL files use `\echo` or `--` comments and `SELECT` statements but **no output rows**:

| File | Example IDs embedded in WHERE clauses |
|------|--------------------------------------|
| `tmp_pbx_tenant.sql` | `pbxInstanceId = 'cmmi7huxy0000qq3igj493o5q'` |
| `verify_isolation.sql` | `tenantId = 'cmnlgryp8001lp9pajhatv3t9'` |

These prove query shape and that specific IDs existed when scripts were authored; they do not prove current production state.

---

## 8. Secrets redacted in archive

| File | Redacted field |
|------|----------------|
| `etc-asterisk/asterisk/ari.conf` | `password = REDACTED` |
| `etc-asterisk/asterisk/manager.conf` | `secret = REDACTED` |
| `extensions__60_custom.conf` | `WAKE_SECRET=REDACTED` (line 222; appears truncated in archive) |
| `services/asterisk-status.txt` | `UsingPassword=REDACTED` |

**Impact:** Cannot verify credentials or reproduce AMI/ARI/wake authentication from extract.

---

## 9. `did_management` UI module not extracted

`PBX_ARCHITECTURE_PLAN.md` lists `www/modules/did_management/` in the target subset.

Extract search shows DID-related content only in:

- `migrations/multi-tenant/mt.1.dids_tbl.sql`
- `migrations/multi-tenant/mutli_tenant.20230317.2.DID_management.sql`
- `tenants/DIDNumber.php`

No `www/modules/did_management/` directory is present in `extracted-useful/`.

**Impact:** DID management UI module structure not available in extract; schema/migration evidence only.

---

## 10. Nested blueprint not expanded

**File:** `backups/pbx-blueprint-20260609-062846.tar.gz`

Present but not unpacked into `extracted-useful/`. Parent extract already contains overlapping CLI and config paths per plan.

---

## 11. Extract count vs plan estimate

| Metric | Value |
|--------|------|
| Plan estimate | ~495 paths (~6.8% of archive) |
| Actual extracted files | 426 |
| `asterisk-cli/` files | 13 (plan cited 14) |

Difference likely directory entries vs files; no evidence of missing Tier A/B paths in spot checks.

---

## 12. Duplicate schema copy

Both paths contain identical `20191218.3.tables.sql`:

- `vitalpbx/vitalpbx/migrations/20191218.3.tables.sql`
- `backups/20191218.3.tables.sql`

Plan intentionally included base backups SQL; treat migrations copy as canonical path.

---

## 13. Readable dialplan is Connect-owned, not VitalPBX-owned

The only fully readable telephony logic in the extract is:

- `extensions__60_custom.conf`
- `extensions__65_connect_tenant_moh.conf`

VitalPBX-generated dialplan in `vitalpbx/extensions__50-*-dialplan.conf` is present but **compiled output** — editing it directly is not supported by VitalPBX workflow (per Connect file headers referencing install scripts).

---

## Safe uses of this extract

| Use case | Supported? | Evidence basis |
|----------|------------|----------------|
| Map Connect AstDB keys | Yes | `extensions__60_custom.conf` |
| Understand `ombu_*` schema | Yes | `20191218.3.tables.sql` |
| Inventory `api_v2` endpoints | Partial (filenames only) | `www/api_v2/` listing |
| List AMI/ARI usernames | Yes | CLI + config headers |
| Audit VitalPBX PHP logic | No | ionCube |
| Reconstruct production routing table | No | No MariaDB dump |
| Listen to tenant prompts | No | Audio excluded |

---

## Required follow-ups (outside this extract)

To answer questions this bundle cannot:

1. Query live `ombutel` or VitalPBX `api_v2/tenants/read.php` for tenant rows
2. Read Connect codebase for AstDB writers and `TenantPbxLink` sync
3. Use AMI/ARI with production credentials (not in extract)
4. Pull CDR/sample calls from `ConnectCdr` per `check_pbx.sql` shape

---

## Related documents

- `PBX_ARCHITECTURE_PLAN.md` — full archive gaps (section 7)
- `PBX_ARCHITECTURE.md` — what was extracted
- `CONNECT_INTEGRATION_POINTS.md` — evidenced integration surfaces

*Generated from `extracted-useful/` and `PBX_ARCHITECTURE_PLAN.md` only.*
