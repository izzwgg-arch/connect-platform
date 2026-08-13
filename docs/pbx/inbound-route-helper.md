# VitalPBX Inbound Route Helper

This helper lets Connect safely retarget any explicitly selected VitalPBX DID
inbound route to the Connect IVR entry, restore it later, and sync tenant-wide
Music-On-Hold settings without giving Connect broad MySQL or root access.

The helper is not tied to one phone number. Connect passes `{ did, tenantId }`
on every request. The DID Routing page decides which Connect IVR profile answers
that DID by publishing `connect/didmap/<did>/*` AstDB keys before retargeting
the PBX route.

## Write Surface

The helper has two narrow write surfaces.

DID retarget/restore updates exactly one table and one field:

- Table: `ombutel.ombu_inbound_routes`
- Match guard: `tenant_id = <VitalPBX tenant_id>` and normalized `did = <DID>`
- Updated field: `destination_id`
- Drift guard: the `WHERE` clause also includes the current `destination_id`
  read earlier in the transaction.

Tenant MOH sync updates only native MOH pointers for one VitalPBX tenant:

- Table: `ombutel.ombu_inbound_routes`
- Match guard: `tenant_id = <VitalPBX tenant_id>`
- Updated field: `music_group_id`
- Table: `ombutel.ombu_extensions`
- Match guard: `tenant_id = <VitalPBX tenant_id>`
- Updated field: `music_group_id`
- Table: `ombutel.ombu_queues` (auto-detected when the schema includes `tenant_id` + `music_group_id`) — **callers holding in a queue hear this MOH**; Asterisk `Queue()` does not use the inbound caller’s `CHANNEL(musicclass)`.

The helper reads `ombutel.ombu_destinations` only to verify the target
`destination_id` exists. It reads `ombutel.ombu_music_groups` only to verify
the selected MOH group exists. It does not touch SIP trunks, tenant records,
IVR definitions, devices, or Asterisk config files directly (aside from optional
`dialplan reload` / `moh reload` apply hooks, and the one narrow file-surgery
action below).

**transport-wss cert self-heal** (added certfix, 2026-07) edits exactly two
`key=value` lines — `cert_file` and `priv_key_file` — inside the single named
section (`[transport-wss]` by default) of one file (`/etc/asterisk/pjsip.conf`
by default). It never touches any other line, section, or file, and it is a
true no-op (`changed: false`) whenever the current `cert_file`/`priv_key_file`
already resolve to a readable PEM. See "transport-wss cert self-heal" below.

## Endpoints

Bind it to loopback or a private address only.

- `GET /health`
- `GET /transport-wss/status` — read-only, never writes
- `POST /inspect`
- `POST /retarget`
- `POST /restore`
- `POST /sync-tenant-moh`
- `POST /ensure-transport-wss-cert`

Every `POST` requires `x-connect-pbx-helper-secret`. Bodies use strict numeric
DID and tenant validation:

```json
{
  "did": "+8455577768",
  "tenantId": "21",
  "requestId": "connect-log-id",
  "actor": "user-id"
}
```

`/retarget` also uses `connectDestinationId`, either from the request body or
from `CONNECT_PBX_CONNECT_DESTINATION_ID`.

`/sync-tenant-moh` uses tenant-wide payloads:

```json
{
  "tenantId": "21",
  "musicGroupId": "8",
  "requestId": "connect-log-id",
  "actor": "connect:moh-publish"
}
```

It returns row counts for inbound routes and extensions, plus small verification
samples. Connect treats this as part of the MOH publish contract so the portal
does not show a false success when native VitalPBX rows were not updated.

## PBX Install

On the VitalPBX host:

```bash
install -d -m 0750 /opt/connect-pbx-helper /var/lib/connect-pbx-helper
cp vitalpbx-inbound-route-helper.py /opt/connect-pbx-helper/
python3 -m venv /opt/connect-pbx-helper/.venv
/opt/connect-pbx-helper/.venv/bin/pip install pymysql
```

Create `/etc/connect-pbx-helper.env`:

```bash
CONNECT_PBX_HELPER_BIND=127.0.0.1
CONNECT_PBX_HELPER_PORT=8757
CONNECT_PBX_HELPER_SECRET=replace-with-64-random-chars

OMBU_MYSQL_HOST=127.0.0.1
OMBU_MYSQL_PORT=3306
OMBU_MYSQL_DB=ombutel
OMBU_MYSQL_USER=connect_route_helper
OMBU_MYSQL_PASSWORD=replace-with-limited-password

# Destination row in ombu_destinations for the Connect custom-context entry.
CONNECT_PBX_CONNECT_DESTINATION_ID=607

# Optional. Configure only after validating the exact VitalPBX-safe command.
CONNECT_PBX_HELPER_APPLY_COMMAND=asterisk -rx "dialplan reload"
```

Create a narrow MySQL user on the PBX:

```sql
CREATE USER 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY 'replace-with-limited-password';
CREATE USER 'connect_route_helper'@'localhost' IDENTIFIED BY 'replace-with-limited-password';
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (destination_id, music_group_id) ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_extensions TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (music_group_id) ON ombutel.ombu_extensions TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_queues TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (music_group_id) ON ombutel.ombu_queues TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_music_groups TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT UPDATE (destination_id, music_group_id) ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_extensions TO 'connect_route_helper'@'localhost';
GRANT UPDATE (music_group_id) ON ombutel.ombu_extensions TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_queues TO 'connect_route_helper'@'localhost';
GRANT UPDATE (music_group_id) ON ombutel.ombu_queues TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_music_groups TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'localhost';
FLUSH PRIVILEGES;
```

Systemd unit:

```ini
[Unit]
Description=Connect VitalPBX inbound route helper
After=network-online.target mariadb.service

[Service]
Type=simple
EnvironmentFile=/etc/connect-pbx-helper.env
ExecStart=/opt/connect-pbx-helper/.venv/bin/python /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py
Restart=on-failure
RestartSec=3
User=connect-route-helper
Group=connect-route-helper
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/connect-pbx-helper

[Install]
WantedBy=multi-user.target
```

Then:

```bash
systemctl daemon-reload
systemctl enable --now connect-pbx-helper
curl http://127.0.0.1:8757/health
```

## Connect Configuration

For a single PBX:

```bash
PBX_ROUTE_HELPER_BASE_URL=http://127.0.0.1:8757
PBX_ROUTE_HELPER_SECRET=replace-with-64-random-chars
PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID=607
```

For multiple PBX instances:

```json
{
  "cmmi7huxy0000qq3igj493o5q": {
    "baseUrl": "http://10.0.0.21:8757",
    "secret": "replace-with-64-random-chars",
    "connectDestinationId": 607
  }
}
```

Put that JSON in `PBX_ROUTE_HELPER_BY_INSTANCE_JSON`.

## Rollback Behavior

On first retarget, the helper stores the full original
`ombu_inbound_routes` row in SQLite at
`/var/lib/connect-pbx-helper/snapshots.sqlite3` and writes an audit event to
`/var/lib/connect-pbx-helper/audit.jsonl`.

Restore:

- Finds the exact DID and tenant.
- Loads the captured original `destination_id`.
- Rejects if the current route no longer points to the helper's Connect
  destination, unless `force=true`.
- Updates only `destination_id` back to the captured original.

If the DID is missing, multiple rows match, or the current destination drifted,
the helper rejects the request and leaves the PBX untouched.

MOH sync is idempotent. If all inbound routes and extensions are already on the
requested `music_group_id`, the helper returns success with zero updated rows
and still reports totals/samples for verification.

## transport-wss cert self-heal

Root cause this addresses: the DEFAULT `[transport-wss]` PJSIP transport in the
base (hand-maintained, not VitalPBX-generated) `/etc/asterisk/pjsip.conf`
originally pointed `cert_file`/`priv_key_file` at a static self-signed
`astgenkey` cert under `/etc/asterisk/keys/`. If that directory is ever lost,
`res_sorcery_config` fails to create the `transport-wss` object on every
subsequent `pjsip reload` / `apply_changes`, which silently blocks any **new**
outbound registration object from starting (already-loaded registrations keep
refreshing, masking the problem until the next new trunk is added).

- `GET /transport-wss/status` — reports the current `cert_file`/`priv_key_file`
  values from the configured section, whether each resolves to a file
  containing a `-----BEGIN` PEM header, the configured desired replacement
  paths and whether *they* are currently valid, and (best-effort) a live
  `pjsip show transports` snapshot. **Never writes anything.**
- `POST /ensure-transport-wss-cert` — idempotent. Body: `{"dryRun": bool,
  "actor": str, "requestId": str}`.
  - If the current `cert_file` AND `priv_key_file` already resolve to a
    readable PEM, returns `{"ok": true, "changed": false, "reason":
    "cert_files_already_present"}` and touches nothing. Safe to call
    unconditionally on a schedule (mirrors the MOH sync no-op contract).
  - If `dryRun: true`, returns the before/after plan without writing.
  - Otherwise, verifies the **desired** replacement paths
    (`CONNECT_PBX_TRANSPORT_WSS_DESIRED_CERT_FILE` /
    `..._DESIRED_KEY_FILE`, default the VitalPBX Let's-Encrypt-managed bundle
    at `/usr/share/vitalpbx/certificates/<domain>/{bundle,private}.pem`) are
    themselves valid PEM files — refuses with no write if not — snapshots the
    original file text once (SQLite, same `snapshots.sqlite3`), rewrites only
    the two `key=value` lines inside the named section span, runs
    `CONNECT_PBX_TRANSPORT_WSS_RELOAD_COMMAND` (default `asterisk -rx "module
    reload res_pjsip.so"`), and returns the reload output plus a fresh
    `transport-wss/status`-equivalent read-back for verification.
- Config (`/etc/connect-pbx-helper.env`):
  `CONNECT_PBX_TRANSPORT_WSS_CONF_PATH`, `CONNECT_PBX_TRANSPORT_WSS_SECTION`,
  `CONNECT_PBX_TRANSPORT_WSS_DESIRED_CERT_FILE`,
  `CONNECT_PBX_TRANSPORT_WSS_DESIRED_KEY_FILE`,
  `CONNECT_PBX_TRANSPORT_WSS_RELOAD_COMMAND`.

**This code is written and reviewable but, per Connect's PBX guardrails
(`AGENTS.md`), installing/re-running the installer on the PBX host — the step
that actually deploys this capability — requires explicit, in-the-moment
owner authorization. It has not been installed as of this writing.**

## Example Test DID: Landau Home

One known test row observed for `8455577768` / tenant `21`:

- `ombu_inbound_routes.inbound_route_id = 72`
- `ombu_inbound_routes.did = 8455577768`
- `ombu_inbound_routes.tenant_id = 21`
- Original `destination_id = 460`

The Connect custom-context destination observed on that PBX was
`destination_id = 607`; validate this on the PBX before setting
`CONNECT_PBX_CONNECT_DESTINATION_ID`.

Any other DID works the same way as long as exactly one
`ombu_inbound_routes` row exists for that DID and tenant.
