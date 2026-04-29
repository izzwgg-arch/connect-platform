# VitalPBX Inbound Route Helper

This helper lets Connect safely retarget any explicitly selected VitalPBX DID
inbound route to the Connect IVR entry and restore it later without giving
Connect broad MySQL or root access.

The helper is not tied to one phone number. Connect passes `{ did, tenantId }`
on every request. The DID Routing page decides which Connect IVR profile answers
that DID by publishing `connect/didmap/<did>/*` AstDB keys before retargeting
the PBX route.

## Write Surface

The helper updates exactly one table and one field during retarget/restore:

- Table: `ombutel.ombu_inbound_routes`
- Match guard: `tenant_id = <VitalPBX tenant_id>` and normalized `did = <DID>`
- Updated field: `destination_id`
- Drift guard: the `WHERE` clause also includes the current `destination_id`
  read earlier in the transaction.

The helper reads `ombutel.ombu_destinations` only to verify the target
`destination_id` exists. It does not touch SIP trunks, extensions, tenants,
queues, IVRs, devices, or any Asterisk config files.

## Endpoints

Bind it to loopback or a private address only.

- `GET /health`
- `POST /inspect`
- `POST /retarget`
- `POST /restore`

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
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (destination_id) ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
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
