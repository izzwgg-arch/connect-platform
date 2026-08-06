# Handoff — Connect doorway rebuild + switch hardening (2026-08-05)

> **⛔ SUPERSEDED IN PART — read `AGENT_HANDOFF_IVR_RUNTIME_2026-08-06.md` first.**
> The doorway itself works, but on 2026-08-06 the shared doorway destination row
> (903) was found REPURPOSED by the VitalPBX panel — every id-equality check
> ("mode", doorway-status, the reconciler) reported CONNECTED while callers
> reached a PBX IVR. Ground truth is now the RENDERED Goto, the doorway target
> is a constant, and repair mints a fresh destination pair. Getting a caller
> THROUGH the doorway to the right menu had five further defects, all covered in
> the newer handoff.
>
> **⛔ Also read `AGENT_HANDOFF_PBX_PANEL_LOCKOUT_2026-08-06.md`** before touching
> the regen/bake path described below. Every switch here runs a full per-tenant
> regen, and that regen used to leave `extensions__50-<t>-dialplan.conf` owned
> `asterisk:asterisk` — which locks the VitalPBX **panel** out of that tenant
> (`file_put_contents … Permission denied`) while calls keep working normally.
> Fixed in two halves: the helper chowns the confs back to `www-data:www-data`
> 0644 (`fc826643`), and the service was granted `CAP_CHOWN`/`CAP_FOWNER` so
> those chowns can actually succeed (`2f017f88`). Any NEW code path that writes
> a generated tenant conf must call `_chown_gui_conf()` after `os.replace`.

Branch `feat/ivr-migration-takeover`, tip `e9ab55ca` (api + portal BOTH deployed,
jobs `217e2052`/`1cd85229`, container-verified). PBX work done under Izzy's
explicit chat mandate ("I give you permission to carefully modify the PBX").

## The one sentence

Every switch-to-connect on the platform had been silently broken since ~May
because the PBX "doorway" destination (id 607) was deleted; a new
self-discovering, self-healing doorway is fully built and deployed on both
sides, and **the only step left is one MySQL GRANT that Izzy must run himself**
(classifier-blocked for agents), after which the first switch auto-creates the
doorway rows and the number flip + cycle test can run.

## What was wrong (full chain, all PBX-verified read-only)

1. **Izzy's report**: published an IVR Studio menu for Connect Communications,
   assigned (845) 723-1213, called it — still reached ext 1101 (the old
   routing). The Studio showed nothing wrong (silent failure — now fixed).
2. The switch DID run: `POST /voice/did/:id/switch-to-connect` captured the
   original destination (689 = extension 1101), published AstDB, then the
   helper `/retarget` failed with `helper_retarget_failed:
   connect_destination_not_found` → `DidRouteMapping.lastSwitchError`.
3. Root cause: the configured doorway `CONNECT_PBX_CONNECT_DESTINATION_ID=607`
   (also `PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID=607` on loopcom) points at an
   `ombu_destinations` row that NO LONGER EXISTS. It was the April-era doorway:
   a per-tenant **Custom Application** (T21 ext 8001, custom_application_id 18
   — note the id gap 17→19) rendering `Goto(T21_app-custom-application,8001,1)`
   → `connect-entry` (context also gone from the live dialplan; only in
   backups). A panel cleanup deleted the row; the `ombu_custom_contexts` /
   `ombu_destinations` FK is ON DELETE CASCADE both directions, so the whole
   doorway vanished. `ombu_custom_contexts` is now EMPTY (AUTO_INCREMENT=2).
4. **Bonus finding**: Landau Home's mapping said `routingMode=connect`, but the
   PBX route for 8455577768 was REBUILT at some point (route id 72 → 68) and now
   points at dest 456 = T21 ext 101 directly. Our DB was corrected to
   `routingMode=pbx` this session. The helper snapshot DB
   (`/var/lib/connect-pbx-helper/snapshots.sqlite3`) still holds one orphan row
   for dead route 72 (original 460 → connect 607) — historical, left alone.

Useful decoder (all confirmed live): `ombu_destinations` = (id, category_id,
`index`); `ombu_destinations_category` (id, module_id) → `ombu_modules.name`.
Extensions = category 1; custom_contexts = category 33 (module 154);
custom_app = category 5 (module 9). `index` = target table row id.
CC's DID 8457231213 = tenant 35 route 109, current dest 689 (ext_id 168 =
ext 1101). Loopcom Demo 3479780090 = tenant 102 route 233.

## The new doorway design (deployed)

One GLOBAL VitalPBX **Custom Context** destination — context `connect-doorway`,
extension `s` — instead of per-tenant custom apps. Three self-healing layers in
the helper (v2026.08.05.1, deployed, backup
`/root/helper-backup-doorway-20260805.py` on the PBX):

- **Discovery by NAME, never by pinned id**: `resolve_connect_destination()`
  order = request id → env pin → doorway-by-context-name, where request/env ids
  are honoured ONLY if the row still exists. A stale pin (like 607, both env
  pins deliberately LEFT stale) is recorded in evidence and skipped — the
  staleness class that caused this outage cannot fail a switch again.
- **Dialplan self-heal**: `ensure_connect_doorway_dialplan()` writes
  `/etc/asterisk/vitalpbx/extensions__96-connect-doorway.conf` (embedded body in
  the helper, atomic write, `asterisk:asterisk`, reload only on change; the
  `extensions__*` double-underscore name is REQUIRED for VitalPBX's include
  glob) — runs soft at helper boot, STRICT inside `/retarget` (a flip never
  proceeds toward a context that isn't answering). **Verified live**:
  `dialplan show connect-doorway` shows the context, installed at boot.
- **Row self-heal**: `ensure_connect_doorway_rows()` creates the
  `ombu_destinations` + `ombu_custom_contexts` pair (circular FK: placeholder
  `index='0'`, insert cc, backfill index) INSIDE the retarget transaction.
  ⛔ **This is the part waiting on the GRANT below** — the helper's MySQL user
  can't yet touch `ombu_custom_contexts`.

The shim context recovers the DID from `${CALLERID(dnid)}` (proven pattern from
the April custom app), resolves the tenant from `DB(connect/didmap/<did>/tenant)`
(published by the api BEFORE every retarget), sets `__TENANT_SLUG`, and enters
`[connect-tenant-ivr]` with the DID as EXTEN. A `_[+0-9].` direct-DID pattern
covers a future render that passes the DID through. `i`/`t`/no-DNID land in
`connect-default-fallback`.

Also hardened on the PBX (same mandate, backups taken alongside per the
session's `.bak` pattern in /etc/asterisk):
- `[connect-tenant-ivr]` and `[connect-tenant-router]` in
  `extensions__60_custom.conf` now resolve the tenant from the didmap BEFORE
  the empty-TENANT_SLUG bailout (was: bail first, resolve after — a doorway
  that forgot to set the slug hit "goodbye").
- `_route_is_connect_managed()` (the agent-write fence) also recognizes the
  doorway by name, not just the env pin + snapshots.
- New READ-ONLY `POST /doorway-status` on the helper: file/context/rows/pin
  health + `wouldUse`. (Currently errors on the missing SELECT grant — that is
  expected until the GRANT runs.)

## Connect-side (deployed at e9ab55ca)

- Picker auto-fill (earlier commit `8dfb9c4c`, separately deployed+verified):
  `GET /voice/ivr/numbers` auto-registers draft-only `DidRouteMapping` rows
  (routingMode `pbx`, changes nothing for callers) for every active
  `PbxTenantInboundDid` the tenant owns; cross-tenant e164s skipped via the
  unique constraint. Tests in `apps/api/src/didSwitchSchedule.test.ts`.
- **Loud failures**: the Studio surfaces a failed switch in a plain-English
  banner instead of silently "publishing"; the numbers list carries
  `lastSwitchError` so a broken number shows a persistent ⚠.

## ⛔ THE ONE BLOCKING STEP — Izzy runs this, agents CANNOT

The auto-mode classifier hard-blocks agents from GRANT statements AND from raw
SQL INSERTs into the PBX DB (verbal permission does not help; deploy-queue
enqueues DID pass on retry after explicit chat permission, these do not):

```bash
ssh -i C:/Users/izzyw/.ssh/connect2_server2_ed25519 -p 22 root@209.145.60.79 "mysql -e \"GRANT SELECT, INSERT ON ombutel.ombu_custom_contexts TO 'connect_route_helper'@'localhost'; GRANT UPDATE (\\\`index\\\`) ON ombutel.ombu_destinations TO 'connect_route_helper'@'localhost'; FLUSH PRIVILEGES;\""
```

Scope: lets the helper read/create doorway rows and backfill the one `index`
column. Nothing else. As of handoff time this has NOT been run
(`ombu_custom_contexts` count = 0, grants unchanged) — a 20-min background
watcher from the session may have expired.

## Exactly what the next agent does after the grant

1. Verify grant: `SHOW GRANTS FOR 'connect_route_helper'@'localhost'` includes
   `ombu_custom_contexts`. Then `POST /doorway-status` (from the PBX:
   `S=$(grep CONNECT_PBX_HELPER_SECRET= /etc/connect-pbx-helper.env | cut -d= -f2);
   curl -s -X POST http://127.0.0.1:8757/doorway-status -H "x-connect-pbx-helper-secret: $S" -d '{}'`)
   — expect `contextLive:true`, `rows:[]` (rows appear on first switch).
2. **Flip through the REAL path** — never raw helper curl (that would desync
   Connect state): insert a `DidSwitchSchedule` row for mapping
   `cmsg79jlv048bll1490jrjyyd` (+8457231213, tenant `cmqzfigij4bt0mw13u2ulpd0t`
   Connect Communications), `ivrProfileId cmseuklc80001o7133ke49etw` ("main
   menu"), `status 'pending'`, `activateAt` = now, `endAt` null. The api's 60s
   scheduler tick executes the real `/voice/did/:id/switch-to-connect` via
   service JWT (one code path, full logging). DB one-liner pattern: pipe JS
   into `docker exec -i -w /app/packages/db app-api-1 node -` on loopcom
   (`ssh connect`).
3. Verify ALL of: `DidRouteSwitchLog` status `success`; mapping
   `routingMode=connect` + `lastSwitchError` null; helper response
   `doorway.doorwayCreated:true` (in the log row's pbxPayload); PBX route 109
   `destination_id` = the new doorway dest id; **the regenerated render** in
   `/etc/asterisk/vitalpbx/extensions__50-35-dialplan.conf` for `_8457231213`
   — ⛔ THIS IS THE ONE UNPROVEN ASSUMPTION: a custom-context destination has
   never been rendered on this box (table was empty). Expected
   `Goto(connect-doorway,s,1)`; the `_[+0-9].` pattern covers a DID-passing
   variant. If the render is something else entirely, the helper `/restore`
   rolls route 109 back to 689 (snapshot exists) — then rethink with the
   render in hand.
4. AstDB sanity (read-only): `asterisk -rx "database show connect/didmap/8457231213"`
   → tenant slug present; `connect/t_<slug>` family has mode/dest keys.
5. **Prove the cycle** (Izzy's explicit bar: "back and forth… should never,
   ever fail"): switch-to-pbx (same schedule mechanism with an end, or the
   Studio), verify route 109 back at 689 and callers reach ext 1101; then
   switch-to-connect again; LEAVE ON CONNECT. Then Izzy calls (845) 723-1213
   and should hear the "main menu" IVR.
6. Second `/doorway-status`: `healthy:true`, one row, `wouldUse` = its id.

## Traps / environment notes for this exact work

- **PBX ssh**: the `~/.ssh/config` alias `pbx` uses port 2222 and TIMES OUT.
  Working: `ssh -i "C:/dev/projects/Connect 2/.connect-ssh/connect2_server2_ed25519" -p 22 root@209.145.60.79`
  from Git Bash. loopcom is `ssh connect`.
- Helper repo copy `scripts/pbx/vitalpbx-inbound-route-helper.py` is IN SYNC
  with the PBX (sha-verified before edit; deploy = scp → remote
  `python3 -m py_compile` → `install -m 755` → `systemctl restart
  connect-pbx-helper` → status). Keep it that way.
- Both stale 607 env pins (loopcom `.env.platform`, PBX
  `/etc/connect-pbx-helper.env`) are LEFT IN PLACE on purpose — the helper now
  skips stale pins, and removing them needs api-container env reload for zero
  benefit. Do not "fix" by re-pinning a new id; name-discovery is the design.
- The dead remnant `[T21_app-custom-application]` ext 8001 →
  `Goto(connect-entry,s,1)` in `extensions__60_custom.conf` is dead code
  (connect-entry gone); left untouched.
- A plus center's two mappings (8457823064 / 8457826775, still
  `routingMode=pbx`, menus copied) will ride the SAME doorway when their
  go-live flip finally happens — nothing tenant-specific to build.
- `deploy-direct` etc.: deploy queue on loopcom (`127.0.0.1:3910`), token in
  `/opt/connectcomms/env/.env.platform`, api before portal, terminal status
  string `success`. Local `git push` blocked → bundle → server → push route.
- The api test suite runs `node --experimental-test-module-mocks --import tsx
  --test`; suite was green (1529/0) including the new picker tests before the
  e9ab55ca deploy.
