# PBX Architecture

Evidence from `docs/pbx-brain/extracted-useful/` (selective extract per `PBX_ARCHITECTURE_PLAN.md`).

**Extract stats:** 426 files under `extracted-useful/pbx-full-brain-20260609-063057/`. No `.wav`, `.png`, `i18n/`, `provisioning/`, `firewall_zones/`, or `static/` paths present in the extract (verified by file scan).

---

## Purpose

`extracted-useful/pbx-full-brain-20260609-063057/README.md` describes this bundle as a **local read-only PBX knowledge bundle** containing Asterisk configs, VitalPBX files, CLI outputs, service/system info, backup discovery, and a log file index — intended to understand PBX structure before changing Connect.

---

## Layered architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Connect (PostgreSQL) — diagnostic SQL only in this extract      │
│   PbxInstance, TenantPbxLink, PbxTenantDirectory, TenantPbxPrompt│
└────────────────────────────┬────────────────────────────────────┘
                             │ AstDB keys + wake API (dialplan)
┌────────────────────────────▼────────────────────────────────────┐
│ Asterisk runtime (compiled configs + Connect overlays)          │
│   etc-asterisk/asterisk/extensions__60_custom.conf              │
│   etc-asterisk/asterisk/extensions__65_connect_tenant_moh.conf  │
│   etc-asterisk/asterisk/vitalpbx/* (generated fragments)        │
└────────────────────────────┬────────────────────────────────────┘
                             │ config generation
┌────────────────────────────▼────────────────────────────────────┐
│ VitalPBX application (PHP modules + api_v2 + migrations)        │
│   vitalpbx/vitalpbx/www/modules/*                               │
│   vitalpbx/vitalpbx/www/api_v2/*                                │
│   vitalpbx/vitalpbx/migrations/*                                │
└────────────────────────────┬────────────────────────────────────┘
                             │ schema
┌────────────────────────────▼────────────────────────────────────┐
│ MariaDB `ombutel` — schema/migrations only (no live dump)       │
│   vitalpbx/vitalpbx/migrations/20191218.3.tables.sql            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Top-level components in extract

| Directory | Files | Role | Source |
|-----------|------:|------|--------|
| `vitalpbx/` | 200 | VitalPBX app: modules, API, migrations, includes | extract dir listing |
| `etc-asterisk/` | 185 | Asterisk config tree + VitalPBX-generated fragments | extract dir listing |
| `asterisk-cli/` | 13 | Runtime CLI snapshots at export time | extract dir listing |
| `backups/` | 11 | Base schema SQL, Connect diagnostic queries, nested blueprint tarball, `found-backups.txt` | extract dir listing |
| `system/` | 8 | Host diagnostics | extract dir listing |
| `services/` | 7 | systemd service status snapshots | extract dir listing |
| `log-index/` | 1 | Log path index (no log bodies) | `log-index/log-files.txt` |
| `README.md` | 1 | Bundle description | `README.md` |

---

## Asterisk configuration chain

`extracted-useful/.../etc-asterisk/asterisk/extensions.conf` includes:

1. `#include vitalpbx/extensions__*.conf` — VitalPBX-generated dialplan
2. `#include /etc/asterisk/vitalpbx/extensions_90-t25-afterhours-screening.conf` — per-tenant custom include (path referenced; file not in extract subset)
3. `#include extensions__60_custom.conf` — Connect overlay

Connect MOH is pulled in at the end of `extensions__60_custom.conf`:

```
#include extensions__65_connect_tenant_moh.conf
```

(Source: `etc-asterisk/asterisk/extensions.conf`, `etc-asterisk/asterisk/extensions__60_custom.conf` lines 268–269.)

Root Asterisk entry points delegate to VitalPBX fragments:

| Root file | Include pattern | Source |
|-----------|-----------------|--------|
| `ari.conf` | `#include vitalpbx/ari__*.conf` | `etc-asterisk/asterisk/ari.conf` |
| `manager.conf` | `#include vitalpbx/manager__*.conf` | `etc-asterisk/asterisk/manager.conf` |
| `http.conf` | `#include vitalpbx/http__*.conf` | `etc-asterisk/asterisk/http.conf` |
| `pjsip.conf` | (present; includes vitalpbx pjsip fragments) | `etc-asterisk/asterisk/pjsip.conf` |

---

## Generated VitalPBX Asterisk fragments

Under `etc-asterisk/asterisk/vitalpbx/` (155 files in extract):

| Prefix | Count | Purpose |
|--------|------:|---------|
| `extensions__*` | 54 | Per-tenant / base dialplan |
| `pjsip__*` | 50 | Endpoints, trunks, profiles, transports |
| `manager__*` | 25 | AMI user fragments |
| `queues__*` | 24 | Queue definitions |
| `ari__*` | 2 | ARI user fragments |

Naming pattern observed: `{type}__{priority}-{tenant_or_scope}-{detail}.conf` — e.g. `extensions__50-28-dialplan.conf`, `pjsip__50-28-trunks.conf`, `queues__50-29-main.conf`.

---

## Connect dialplan contexts (loaded)

`asterisk-cli/dialplan-show.txt` confirms these Connect contexts exist at runtime:

| Context | Source file cited in dialplan-show |
|---------|-----------------------------------|
| `connect-tenant-router` | `extensions__60_custom.conf` |
| `connect-tenant-ivr` | `extensions__60_custom.conf` |
| `connect-default-fallback` | `extensions__60_custom.conf` |
| `connect-tenant-moh-connect-shim` | `extensions__65_connect_tenant_moh.conf` |
| `sub-connect-tenant-moh` | `extensions__65_connect_tenant_moh.conf` |

`extensions__60_custom.conf` defines additional contexts not all shown in the dialplan-show grep subset:

- `connect-option-router`
- `connect-exit-router`
- `connect-dial-with-wake`
- `connect-hold-announce`
- `connect-entry`

(Source: `etc-asterisk/asterisk/extensions__60_custom.conf` lines 8–269.)

---

## Runtime queue naming

`asterisk-cli/queue-show.txt` shows live queues prefixed by VitalPBX tenant index:

- `T2_Q600`
- `T8_Q750`, `T8_Q751`, `T8_Q752`

Member hints reference contexts like `T8_queue-call-to-agents` and `T8_extension-hints`.

---

## PJSIP transports (WebRTC-related)

`asterisk-cli/pjsip-transports.txt` lists 7 transports including:

- `transport-ws-*` (type `ws`, bind `0.0.0.0:5060`)
- `transport-wss-*` (type `wss`, bind `0.0.0.0:5060`)
- `transport-udp-*`, `transport-tcp-*`, `transport-tls-*`

Schema support for WebRTC profiles is in `vitalpbx/vitalpbx/migrations/20200714.1.webrtc_profile.sql` (`ombu_device_profiles`, `ombu_pjsip_profiles` with `webrtc`, `ice_support`, transport `wss`). `20200929.1.pjsip_ws.sql` disables SIP WebSocket in `sip_settings` in favor of PJSIP WS.

---

## Service state at export

`services/asterisk-status.txt`: Asterisk `active (running)`, PID 2035, host `vmi2718844.contaboserver.net`, export timestamp `Jun 09 06:30:*` 2026.

Log entries in the same file reference live endpoints `T18_105`, `T11_103`, `T3_301`, `T2_111`, `T2_101` — confirming `T{n}_` endpoint naming in production.

---

## Database evidence in extract

| Content | File | What it contains |
|---------|------|------------------|
| Full `ombutel` table DDL | `vitalpbx/vitalpbx/migrations/20191218.3.tables.sql` | `CREATE TABLE ombu_*` |
| Seed data only | `vitalpbx/vitalpbx/migrations/20191218.4.data.sql` | `INSERT INTO ombu_tenants` with `name='vitalpbx'`, default modules |
| Duplicate DDL copy | `backups/20191218.3.tables.sql` | Same schema as migrations copy |
| **Not a MariaDB dump** | `backups/tmp_pbx_tenant.sql` | PostgreSQL `SELECT` on `"PbxTenantDirectory"`, `"PbxExtensionHint"` |

---

## Nested blueprint tarball

`backups/pbx-blueprint-20260609-062846.tar.gz` is included in the extract (per plan). Not expanded in `extracted-useful/`; parent archive already contains overlapping paths documented in `PBX_ARCHITECTURE_PLAN.md`.

---

## Related documents

| Document | Focus |
|----------|-------|
| `VITALPBX_STRUCTURE.md` | Modules, API, migrations, includes |
| `TENANT_MODEL.md` | `ombu_tenants`, DID tables, tenant-scoped entities |
| `CONNECT_INTEGRATION_POINTS.md` | AstDB, AMI/ARI, API, dialplan hooks |
| `RISKS_AND_LIMITATIONS.md` | Gaps, ionCube, missing live data |

*Generated from `extracted-useful/` only.*
