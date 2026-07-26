# connect-robot — automated tenant provisioning for the VitalPBX panel

Lives on the Connect server (loopcom) at `/opt/connect-robot/`. This folder is the
version-controlled copy; the server copy is the live one. Keep them in sync when editing.

## What it does

`provision-tenant.js` provisions a complete customer end-to-end, replicating Izzy's
recorded panel flow exactly (2026-07-26 recording):

1. Trunk (VoIP.ms, codecs ulaw/alaw/g726/g729) → Apply Changes
2. Outbound route (5 dial patterns, prepend 845 on 7-digit) → Apply
3. Route selection (ARS) → Apply
4. Tenant — outbound profile + DID entered in the tenant form → Apply
5. Per person: extension via CSV import (PJSIP, call recording + voicemail ON),
   then WebRTC device (always), then virtual device (only if `virtual_number` given) → Apply
6. Inbound route "Main" (DID → first extension) → Apply

Every save is checked for the panel's hidden error dialogs (it can answer "success"
while carrying an error popup); every created object is verified to exist in the
panel before the flow continues.

## Usage (on loopcom)

```
node /opt/connect-robot/provision-tenant.js job.json
```

`job.json` — one job or an array (arrays run in parallel, one robot account each):

```json
{
  "company": "j&j PLumbing",
  "voipms": { "user": "344022_xx", "pass": "***", "server": "newyork1.voip.ms" },
  "did": "8455577726",
  "people": [
    { "name": "JOhn", "ext": "101", "email": "x@y.com", "virtual_number": "5622096644" }
  ]
}
```

Never commit job files — they contain VoIP.ms passwords.

## Files

- `connect-lib.js` — session/login/CSRF/tenant-switch core + account Pool (up to 15 parallel)
- `provision-tenant.js` — the full A-to-Z provisioning flow (canonical field contract)
- `connect-cli.js`, `connect-assign-did.js` — earlier smaller utilities

Credentials live only in `/etc/connect-robot/credentials.env` on the server
(`CONNECT_BASE_URL`, `CONNECT_ROBOT_N_USER/_PASS`) — never in the repo.

Full background and panel gotchas: the Claude memory file
`connect-panel-automation-contract.md` (checkbox omission rule, hidden dialog errors,
CSV importer quirks, `inbound_route` module naming, etc.).
