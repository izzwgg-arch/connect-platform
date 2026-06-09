# PBX Architecture Plan

Evidence-only analysis of `docs/pbx-brain/pbx-full-brain-20260609-063057.tar.gz`.

**Method:** `tar -tzf` inventory (7,311 paths) plus selective `tar -xOf` reads. No full extraction. No assumptions beyond what the archive contains.

---

## 1. What is inside the archive

| Metric | Value (from archive listing) |
|--------|------------------------------|
| Compressed size | ~476 MB |
| Total paths | 7,311 |
| Root prefix | `pbx-full-brain-20260609-063057/` |

Archive `README.md` states this is a **local read-only PBX knowledge bundle** that may include Asterisk configs, VitalPBX files, VitalPBX backups, Asterisk CLI outputs, service/system info, backup discovery, and a log file index.

### Top-level layout (by path count)

| Directory | Paths | Role |
|-----------|------:|------|
| `vitalpbx/` | 6,521 | VitalPBX application tree (PHP UI modules, API, migrations, provisioning assets) |
| `etc-asterisk/` | 552 | Live Asterisk config tree from `/etc/asterisk` |
| `backups/` | 203 | SQL migration copies, Connect diagnostic SQL, nested `pbx-blueprint-*.tar.gz` |
| `asterisk-cli/` | 14 | Runtime CLI snapshots (`queue show`, `pjsip show transports`, AMI/ARI users, etc.) |
| `system/` | 9 | Host diagnostics (`listening-ports.txt`, `ip-addr.txt`, `memory.txt`, …) |
| `services/` | 8 | Service status snapshots (asterisk, mariadb, vitalpbx, apache2, …) |
| `log-index/` | 2 | **Index only** — lists log file paths on the server; log bodies are not included |

### Largest subtrees inside `vitalpbx/`

| Subtree | Paths | Notes |
|---------|------:|-------|
| `vitalpbx/provisioning/` | 1,590 | Phone vendor templates + images |
| `www/modules/` | 982 | VitalPBX admin UI modules (141 module names observed) |
| `www/includes/` | 642 | Shared PHP (`components/` 400 paths; core helpers like `ivr.php`, `queue.php`) |
| `vitalpbx/static/` | 446 | Hash-named tenant/static storage; **181 `.wav` files** live here |
| `i18n/` | 1,663 | 12 locale trees (`en_US`, `es_ES`, `de_DE`, …) |
| `firewall_zones/` | 245 | Geo/IP zone data files |
| `www/api_v2/` | 90 | REST API surface (28 endpoint directories) |
| `vitalpbx/cache/` | 27 | Cached/generated VitalPBX files |
| `migrations/` | 200+ | Schema history (flat SQL + addon subdirs) |

---

## 2. Category map (where each concern lives)

### VitalPBX source / configuration

| Location | Evidence |
|----------|----------|
| `vitalpbx/vitalpbx/www/modules/` | 141 module directories including `tenants`, `trunks`, `ivr`, `queues`, `time_conditions`, `inbound_route`, `dynamic_routing`, `pjsip_*`, `extensions`, … |
| `vitalpbx/vitalpbx/www/includes/` | Shared logic; top subdirs: `components/` (400), `asterisk/` (38), `addons/` (35) |
| `vitalpbx/vitalpbx/www/api_v2/` | Machine-facing API (`api.php`, `routes.php`, per-resource `read.php` / `create.php` / …) |
| `vitalpbx/vitalpbx/migrations/` | Canonical VitalPBX schema evolution (mirrored under `backups/`) |

**Readability caveat:** Sampled PHP such as `api_v2/vpbx_connect/read.php` and `www/includes/ivr.php` are **ionCube-encoded**. The archive exposes **structure and filenames**, not readable PHP source for those files.

### Database schema

| Location | Evidence |
|----------|----------|
| `backups/20191218.3.tables.sql` | `CREATE TABLE` definitions in `ombutel` schema |
| `vitalpbx/vitalpbx/migrations/20191218.3.tables.sql` | Same base schema (duplicate copy) |
| `backups/20191218.1.vitalpbx.sql`, `20191218.2.asterisk.sql`, `20191218.5.1.core.sql` | Bootstrap / core schema files |
| `vitalpbx/vitalpbx/migrations/multi-tenant/` | Multi-tenant DDL (`mt.1.dids_tbl.sql`, `multi_tenant.sql`, …) |
| `vitalpbx/vitalpbx/migrations/vpbx-connect/` | Connect-addon DDL |
| Remaining `backups/*.sql` / `migrations/*.sql` | Incremental migrations (queues, trunks, pjsip, tenant settings, …) |

**Tables directly tied to Connect-relevant entities** (from `20191218.3.tables.sql`):

- Tenants: `ombu_tenants`, `ombu_tenant_settings`, `ombu_tenants_users`
- Trunks: `ombu_trunks`, `ombu_trunk_parameters`, `ombu_trunk_rules`, `ombu_tenant_trunks`
- Routing: `ombu_inbound_routes`, `ombu_outbound_routes`, `ombu_outbound_route_members`, `ombu_outbound_route_patterns`
- IVR: `ombu_ivrs`, `ombu_ivr_entries`
- Queues: `ombu_queues`, `ombu_queue_members`, `ombu_queue_priorities`, `ombu_queue_vip_lists`
- Time conditions: `ombu_time_conditions`
- PJSIP / endpoints: `ombu_pjsip_profiles`, `ombu_pjsip_devices`, `ombu_pjsip_settings`

### Database dumps (production data)

**Not present in this archive.**

| File | Actual content (read from archive) |
|------|-------------------------------------|
| `backups/tmp_pbx_tenant.sql` | Connect **PostgreSQL** `SELECT` queries against `"PbxTenantDirectory"` and `"PbxExtensionHint"` — not a MariaDB dump |
| `backups/check_pbx.sql` | Connect `SELECT` queries against `"PbxInstance"`, `"TenantPbxLink"`, CDR samples |
| `backups/verify_isolation.sql` | Connect `SELECT` queries against `"TenantPbxPrompt"` (tenant audio isolation proof) |
| `backups/check_links.sql` | Connect diagnostic SQL (not inspected line-by-line; listed in `found-backups.txt`) |
| `backups/20191218.4.data.sql` | **Seed data only** (`INSERT INTO ombu_tenants … 'vitalpbx'`, default modules) — not live tenant/trunk/IVR rows |

`found-backups.txt` catalogs 200 SQL paths on the server; the archive contains copies of those migration files, not `mysqldump` output of the running `ombutel` database.

### Tenant configuration

| Location | Evidence |
|----------|----------|
| `vitalpbx/.../www/modules/tenants/` | 11 paths |
| `vitalpbx/.../www/api_v2/tenants/` | API read surface |
| `vitalpbx/.../migrations/multi-tenant/` | DID/tenant DDL |
| Schema | `ombu_tenants`, `ombu_tenant_settings` |
| Generated dialplan | `etc-asterisk/asterisk/vitalpbx/extensions__50-*-dialplan.conf` (per-tenant numeric suffixes) |
| Connect overlay | `etc-asterisk/asterisk/extensions__60_custom.conf` (`connect-tenant-router`, `connect-tenant-ivr` contexts) |

### Routing configuration

| Location | Evidence |
|----------|----------|
| VitalPBX UI modules | `inbound_route` (7 paths), `dynamic_routing` (9), `custom_dest`, `ars`, `dialrules`, `did_management` |
| VitalPBX API | `api_v2/outbound_routes/`, `route_selections/`, `destinations/` |
| Schema | `ombu_inbound_routes`, `ombu_outbound_routes`, `ombu_outbound_route_members`, `ombu_outbound_route_patterns` |
| Asterisk runtime | `etc-asterisk/asterisk/vitalpbx/extensions__50-*-dialplan.conf`, `extensions__20-baseplan.conf` |
| Connect runtime | `extensions__60_custom.conf` — Option A router using `AstDB` keys `connect/t_${TENANT_SLUG}/…` |
| CLI snapshot | `asterisk-cli/dialplan-show.txt` references `connect-tenant-router`, `connect-tenant-ivr`, `connect-tenant-moh-connect-shim` |

### Trunks

| Location | Evidence |
|----------|----------|
| VitalPBX UI | `www/modules/trunks/` (10 paths), `trunk_group` |
| VitalPBX API | `api_v2/trunks/` |
| Schema | `ombu_trunks`, `ombu_trunk_parameters`, `ombu_trunk_rules`, `ombu_tenant_trunks` |
| Generated PJSIP | `etc-asterisk/asterisk/vitalpbx/pjsip__50-*-trunks.conf`, `pjsip__50-28-trunks.conf`, `iax__50-21-trunks.conf` |
| CLI | `asterisk-cli/pjsip-registrations.txt`, `pjsip-endpoints.txt` |

### IVRs

| Location | Evidence |
|----------|----------|
| VitalPBX UI | `www/modules/ivr/` (9 paths), `ivr_stats` |
| Schema | `ombu_ivrs`, `ombu_ivr_entries` |
| Connect dialplan | `extensions__60_custom.conf` + `asterisk-cli/dialplan-show.txt` context `connect-tenant-ivr` |
| API | `api_v2/destinations/` (destination typing, not a dedicated `ivr/` API dir) |

### Queues

| Location | Evidence |
|----------|----------|
| VitalPBX UI | `www/modules/queues/` (12 paths), `queues_callback`, `queues_vip`, `queues_priority` |
| VitalPBX API | `api_v2/queues/`, `api_v2/agents/` |
| Schema | `ombu_queues`, `ombu_queue_members`, related VIP/priority tables |
| Generated config | `etc-asterisk/asterisk/vitalpbx/queues__50-*-main.conf`, root `queues.conf` |
| CLI snapshot | `asterisk-cli/queue-show.txt` — live queues named `T2_Q600`, `T8_Q750`, `T8_Q751`, `T8_Q752`, … |

### Time conditions

| Location | Evidence |
|----------|----------|
| VitalPBX UI | `www/modules/time_conditions/` (9 paths), `time_group`, `nightmode` |
| Schema | `ombu_time_conditions` |
| Migration | `backups/20200730.1.tc_timezone.sql` |

### ARI / AMI configuration

| Location | Evidence |
|----------|----------|
| Root Asterisk includes | `etc-asterisk/asterisk/ari.conf` (`#include vitalpbx/ari__*.conf`; user `[connectcomms]`), `manager.conf` (`#include vitalpbx/manager__*.conf`; user `[connectcommsgefenu]` with IP permit) |
| Generated fragments | `etc-asterisk/asterisk/vitalpbx/manager__50-*-users.conf` (25 files), `ari__*.conf` (2 files) |
| CLI snapshots | `asterisk-cli/ami-users.txt` — users `astmanager`, `connectcommsgefenu`; `asterisk-cli/ari-users.txt` — users `connectcomms`, `vitalpbx` |

### WebRTC configuration

| Location | Evidence |
|----------|----------|
| CLI transports | `asterisk-cli/pjsip-transports.txt` — `transport-ws-*` (ws) and `transport-wss-*` (wss) on `0.0.0.0:5060` |
| Schema migrations | `20200714.1.webrtc_profile.sql`, `20200929.1.pjsip_ws.sql` (present in both `backups/` and `vitalpbx/migrations/`) |
| Asterisk drivers | `chan_websocket.conf`, `websocket_client.conf`, `vitalpbx/websocket_client__10-realtime-agents.conf` |
| PJSIP profiles | `etc-asterisk/asterisk/vitalpbx/pjsip__40-1-profiles.conf` |
| VitalPBX UI module | `pjsip_settings`, `pjsip_transports`, `pjsip_endpoints` modules exist under `www/modules/` |

---

## 3. Directories that are mostly noise

Evidence counts are from archive path listing.

| Category | Paths / files | Location | Why low value for Connect architecture work |
|----------|---------------|----------|---------------------------------------------|
| **Voicemail recordings** | **0 audio recording files** | No `/var/spool/asterisk/voicemail` tree; no `.mp3`/`.gsm`/`.ulaw`/`.ogg` paths | Archive has voicemail **configuration** only (`voicemail.conf`, `voicemail__50-*-main.conf`, `www/modules/voicemail*`) |
| **Audio prompts (non-VM)** | 181 `.wav` | `vitalpbx/vitalpbx/static/<hash>/` | Tenant prompt blobs; large and redundant with Connect `TenantPbxPrompt` storage model. No filenames — hash directories only |
| **Phone provisioning assets** | 1,590 (379 `.png` alone) | `vitalpbx/vitalpbx/provisioning/` | Vendor template XML + `public/images/`; unrelated to Connect call routing |
| **i18n** | 1,663 | `vitalpbx/i18n/*/` | UI translation strings across 12 locales |
| **Static UI assets** | 446 static + 263 resources + 38 themes | `static/`, `www/resources/`, `www/themes/` | PNG/JS/CSS/TTF (438 `.png`, 78 `.js`, 38 `.css`, 35 `.ttf`) |
| **Firewall geo zones** | 245 | `vitalpbx/vitalpbx/firewall_zones/` | IP geography data, not dial-plan |
| **Cache** | 27 | `vitalpbx/vitalpbx/cache/` | Generated cache artifacts |
| **Duplicate migration SQL** | ~200 × 2 | `backups/` mirrors `vitalpbx/migrations/` | Same migration filenames in both trees |
| **Config backup churn** | Many `*.bak*` siblings | `etc-asterisk/asterisk/extensions__60_custom.conf.bak*`, `extensions__65_connect_tenant_moh.conf.bak*` | Historical editor/deploy backups; superseded by current `.conf` |
| **Log bodies** | 0 | `log-index/log-files.txt` only indexes `/var/log/asterisk/*`, `/var/log/nginx/*`, `/var/log/vitalpbx/*` | Paths listed; files not bundled |

### Nested smaller bundle

`backups/pbx-blueprint-20260609-062846.tar.gz` (30 paths) is a **curated mini-export**: README, system ports, Asterisk CLI text files, and a `configs/` subset (`extensions__60_custom.conf`, `extensions__65_connect_tenant_moh.conf`, `ari.conf`, `manager.conf`, `pjsip.conf`, …). Useful as a quick-reference slice; content overlaps paths already in the parent archive.

---

## 4. What is valuable for Connect

Prioritized by direct overlap with Connect integration work observed in the archive.

### Tier A — Connect-specific runtime truth

| Asset | Why it matters |
|-------|----------------|
| `etc-asterisk/asterisk/extensions__60_custom.conf` | Connect Option A tenant router (`connect-tenant-router`), Phase 2 IVR (`connect-tenant-ivr`), AstDB key layout |
| `etc-asterisk/asterisk/extensions__65_connect_tenant_moh.conf` | Connect MOH shim contexts referenced in live dialplan |
| `asterisk-cli/dialplan-show.txt` | Proves which Connect contexts are loaded and referenced |
| `asterisk-cli/queue-show.txt`, `pjsip-*.txt` | Live queue names, members, transports, registrations |
| `asterisk-cli/ami-users.txt`, `ari-users.txt` | Integration account names in use |
| `backups/tmp_pbx_tenant.sql`, `check_pbx.sql`, `verify_isolation.sql` | Connect-side diagnostic queries (Postgres), document cross-system linkage expectations |

### Tier B — VitalPBX data model and API contracts

| Asset | Why it matters |
|-------|----------------|
| `backups/20191218.3.tables.sql` (+ incremental migrations for entities you touch) | Authoritative `ombu_*` table shapes for tenants, routes, trunks, IVR, queues, time conditions |
| `vitalpbx/.../migrations/multi-tenant/`, `vpbx-connect/` | Tenant/DID and Connect-addon schema deltas |
| `vitalpbx/.../www/api_v2/` | REST surface Connect may call or mirror (`tenants`, `trunks`, `queues`, `extensions`, `outbound_routes`, `vpbx_connect`) |
| `vitalpbx/.../www/modules/{tenants,trunks,ivr,queues,time_conditions,inbound_route,dynamic_routing,pjsip_*}/` | UI module boundaries even when PHP is ionCube-protected |

### Tier C — Generated Asterisk output (reference, not source of truth)

| Asset | Why it matters |
|-------|----------------|
| `etc-asterisk/asterisk/vitalpbx/extensions__50-*-dialplan.conf` | Shows how VitalPBX compiles per-tenant dialplan |
| `etc-asterisk/asterisk/vitalpbx/pjsip__50-*-{extensions,trunks}.conf` | Compiled trunk/endpoint reality |
| `etc-asterisk/asterisk/vitalpbx/queues__50-*-main.conf` | Compiled queue definitions |
| `etc-asterisk/asterisk/ari.conf`, `manager.conf` | Entry points that pull in VitalPBX fragments |

Treat Tier C as **compiled snapshots**. Schema + VitalPBX modules are the maintainable source; generated files include tenant numeric suffixes (`50-28`, `50-31`, …) and backup files.

### Tier D — Host / ops context (secondary)

| Asset | Why it matters |
|-------|----------------|
| `system/listening-ports.txt` | Confirms Asterisk on UDP/TCP 5060/5061, PHP on 8000, Redis 6379, etc. |
| `services/*.txt` | Process health at export time |
| `backups/found-backups.txt` | Provenance map of where files were collected on the server |

---

## 5. What to ignore (for Connect architecture indexing)

| Ignore | Paths | Reason |
|--------|-------|--------|
| Full VitalPBX UI bulk | `i18n/`, `provisioning/`, `firewall_zones/`, `www/themes/`, most of `www/resources/`, `www/includes/components/` | Translation, phone provisioning, skin assets — no Connect routing semantics |
| Audio blobs | `vitalpbx/vitalpbx/static/**/*.wav` | 181 WAV files in hash dirs; Connect stores prompts in `TenantPbxPrompt` (per `verify_isolation.sql`) |
| Duplicate SQL mirror | All of `backups/*.sql` **when** `vitalpbx/migrations/` already extracted | Same migration content twice |
| Historical config backups | `etc-asterisk/**/*.bak*` | Superseded snapshots |
| Log index | `log-index/` | Paths only, no content |
| ionCube PHP bodies | Encoded `www/modules/*/*.php`, `api_v2/vpbx_connect/read.php`, etc. | Index filenames; do not attempt source-level analysis without loader |
| Nested blueprint | Optional — skip if parent Tier A/B/C already extracted | Near-duplicate of larger archive |

---

## 6. Smallest useful subset to extract and index

Target: **~495 paths (~6.8% of archive)** covering Connect integration, schema, API layout, and compiled Asterisk — without audio, i18n, or provisioning bulk.

### Extract list

```
pbx-full-brain-20260609-063057/
  README.md
  asterisk-cli/                          # all 14 files
  system/                                # all 9 files
  services/                              # all 8 files
  log-index/                             # optional; index only
  backups/
    found-backups.txt
    tmp_pbx_tenant.sql
    check_pbx.sql
    verify_isolation.sql
    check_links.sql
    pbx-blueprint-20260609-062846.tar.gz
    20191218.{1,2,3,4}.sql
    20191218.5.1.core.sql
  etc-asterisk/asterisk/
    ari.conf
    manager.conf
    pjsip.conf
    extensions.conf
    extensions__60_custom.conf
    extensions__65_connect_tenant_moh.conf
    queues.conf
    http.conf
    voicemail.conf
    chan_websocket.conf
    websocket_client.conf
    vitalpbx/
      extensions__*
      pjsip__*
      queues__*
      manager__*
      ari__*
  vitalpbx/vitalpbx/
    migrations/
      20191218.*
      multi-tenant/
      vpbx-connect/
      20200714.1.webrtc_profile.sql
      20200929.1.pjsip_ws.sql
    www/
      api_v2/                            # all 90 paths
      modules/
        tenants/
        trunks/
        ivr/
        queues/
        time_conditions/
        inbound_route/
        dynamic_routing/
        pjsip_endpoints/
        pjsip_settings/
        pjsip_transports/
        astmanager_users/
        extensions/
        did_management/
      includes/
        asterisk/
        ivr.php
        queue.php
        ModulesDB.php
```

### Suggested index documents (after selective extract)

1. **Schema index** — table list from `20191218.3.tables.sql` + column highlights for `ombu_tenants`, `ombu_inbound_routes`, `ombu_trunks`, `ombu_ivrs`, `ombu_queues`, `ombu_time_conditions`
2. **API index** — `api_v2/` directory → HTTP verbs/files (from filenames only)
3. **Connect dialplan index** — contexts and AstDB keys from `extensions__60_custom.conf` + `dialplan-show.txt` cross-ref
4. **Compiled Asterisk index** — map `vitalpbx/*__50-<n>-*` suffixes to tenant indices (from dialplan/queue CLI output)
5. **Integration accounts** — AMI/ARI usernames from CLI + `manager.conf`/`ari.conf` headers (secrets redacted in archive)

### PowerShell extract example (selective)

```powershell
$archive = "docs/pbx-brain/pbx-full-brain-20260609-063057.tar.gz"
$dest    = "docs/pbx-brain/extract-index"
$paths   = tar -tzf $archive | Where-Object {
  $_ -match '^pbx-full-brain-20260609-063057/(README\.md|asterisk-cli/|system/|services/|log-index/|backups/(found-backups\.txt|tmp_pbx_tenant\.sql|check_pbx\.sql|verify_isolation\.sql|check_links\.sql|pbx-blueprint|20191218\.(1|2|3|4|5\.1)\.))'
  -or $_ -match '^pbx-full-brain-20260609-063057/etc-asterisk/asterisk/(ari\.conf|manager\.conf|pjsip\.conf|extensions\.conf|extensions__60_custom\.conf|extensions__65_connect_tenant_moh\.conf|queues\.conf|http\.conf|voicemail\.conf|chan_websocket\.conf|websocket_client\.conf|vitalpbx/(extensions__|pjsip__|queues__|manager__|ari__))'
  -or $_ -match '^pbx-full-brain-20260609-063057/vitalpbx/.*/(www/api_v2/|www/modules/(tenants|trunks|ivr|queues|time_conditions|inbound_route|dynamic_routing|pjsip_|astmanager_users|extensions|did_management)/|www/includes/(asterisk/|ivr\.php|queue\.php|ModulesDB\.php)|migrations/(20191218\.|multi-tenant/|vpbx-connect/|20200714\.1\.webrtc_profile\.sql|20200929\.1\.pjsip_ws\.sql))'
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$paths | tar -xzf $archive -C $dest -T -
```

---

## 7. Gaps this archive does not fill

These are **absent** (verified by path search), not merely unextracted:

- Live `ombutel` MariaDB dump (`mysqldump` of tenants, trunks, IVR rows, queue members)
- Voicemail or call recording audio
- Asterisk log file contents
- Readable VitalPBX PHP for ionCube-protected modules
- Connect application source (only SQL diagnostic queries and Asterisk overlays)

For live tenant/trunk/IVR/queue **values**, Connect must query runtime systems (VitalPBX API, MariaDB, or AMI/ARI) — this archive documents **structure and integration points**, not production row data.

---

## 8. Summary

| Question | Answer from archive |
|----------|---------------------|
| What is this? | 7,311-path, ~476 MB PBX knowledge bundle: VitalPBX app tree + `/etc/asterisk` snapshot + CLI/system captures + SQL migrations |
| Best Connect artifacts? | `extensions__60_custom.conf`, `extensions__65_connect_tenant_moh.conf`, Asterisk CLI snapshots, Connect diagnostic SQL, `api_v2/`, base schema SQL |
| Biggest noise? | `i18n/` (1,663), `provisioning/` (1,590), `static/` WAV+assets (627 media-ish files), duplicate `backups/` SQL mirror |
| Smallest useful extract? | ~495 paths (~6.8%): Tier A+B+C in section 6 |
| Production DB state? | **Not included** — only schema migrations and seed SQL |

*Generated 2026-06-09 from `pbx-full-brain-20260609-063057.tar.gz` inventory.*
