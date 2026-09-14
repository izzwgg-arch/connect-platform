# ⛔⛔ AGENT HANDOFF — the PBX CONSOLE replaces the VitalPBX panel from inside Connect: reads + one extension create PROVEN ON PROD (2026-08-19) — READ FIRST before touching `apps/api/src/pbxConsole/*`, `/admin/pbx-console`, before adding a console write, or before "wiring provisioning/geo writes"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §16**
(`6378cb8b` backend + `fd3d0a3c` portal/fixes on `feat/ivr-migration-takeover`.
**api DEPLOYED and container-verified at `6378cb8b`; the audit fix + portal are in
the deploy queue.** One throwaway prod write: ext 155 on Loopcom Demo T102, verified
then to be removed. One live DB grant: `SELECT ON provisioning.*` to `connect_read`,
backup `/root/pbx-console-grants-20260819T060722Z/`.) Izzy, 2026-08-19: *"create a
page for extensions and tenants that has all the options, just like the PBX … I give
you full permission to wire it into the PBX, 100% in production. Be careful. Don't
mess up any other tenants."*

- ⛔⛔ **THE ARCHITECTURE, ONE RULE: reads are SELECTs through the read-only
  `connect_read` user; writes REPLAY THE PANEL through a robot `PanelSession`,
  exactly like onboarding.** The panel is ionCube-encrypted, so the only honest
  description of a record is the FORM it renders — `pbxConsole/panelForm.ts` parses
  that form and re-emits the exact pairs a browser posts, and a write applies the
  changes on top. ⛔ **THE CHECKBOX RULE lives there and has burned this repo
  repeatedly: an unticked checkbox is OMITTED, never sent as `=no` (which TICKS it).**
- ⛔ **`applyAndRebake()` is the ONLY apply and ALWAYS re-bakes the Connect doorway
  afterwards** — Apply Changes is whole-PBX and the VitalPBX regenerator cannot
  render the doorway (2026-08-13 dead-air). Proven: the ext-155 apply left T2/T35/T105
  at **0 cc-wipes**.
- ⛔⛔ **THE FOUR UNLICENSED-PANEL CAPS decide what survives the lapse (mapped on the
  clone):** **extension** create/edit/delete ✅ works unlicensed; **tenant edit/delete**
  ✅ works; **tenant create** ⛔ blocked (the MIRROR already solves it, §11–§14);
  **provisioning save** ⛔ refused over 20 phones; **geo block** ⛔ refused over 1
  country. So Extensions + Tenant-edit go through the panel and survive cancel;
  **Provisioning + Geo WRITES need a direct-DB path** (not built — reads + resync only).
- ⛔ **Extension traps, each with a test (`pbxConsole.test.ts`), proven on the clone:**
  desk phones post **rfc4733**, WebRTC **rfc2833** (the form has no rfc4733 option, so
  the raw value flips DTMF); create is ALWAYS a desk CSV base row then reshaped (a
  virtual base row fails import), and app-only/virtual-only extensions get the base
  desk device unlinked; a device's TYPE can't be changed after creation (refused, not
  applied); a general-only save is refused (it would re-post the raw device fields and
  flip DTMF); blank password = keep current.
- ⛔ **SUPER_ADMIN only, gated three ways:** `navConfig.isNavItemVisibleForUser` forces
  it, `PermissionGate` wraps the page, and every route calls `requireOwner`; the
  `/admin/pbx-console` prefix is in `PORTAL_API_PERMISSION_RULES`
  (`can_manage_global_settings`). ⛔ **Audit is best-effort and can NEVER fail a PBX
  write** — the console is platform-wide (no customer tenant), so it attributes to the
  admin's tenant or skips, in try/catch. A prod create once returned 500 because the
  old audit FK-failed on `tenantId:"platform"` AFTER the panel write already ran.
- ✅ **PROVEN ON PROD (deployed `6378cb8b`):** all four reads (27 tenants, extension
  devices, 55 phones + 427-model catalog, geo 232 blocked + 15 whitelist); one
  extension CREATE (ext 155, desk+app+cell, both PJSIP endpoints loaded, 0 doorway
  wipes) and its DELETE (200/200, PBX byte-back to 119 extensions, orphan endpoints
  cleared with `module reload res_pjsip.so`).
- ✅✅ **THE LAST TWO CAPS ARE BEATEN (handoff §17, `5a312205` + `d0c435b9`).**
  ⛔⛔ **THE FINDING: the cap lives in the panel's SAVE controller, NOT in the
  renderer.** `Device::generateProvisioningFile()` run from PHP CLI on the
  **unlicensed 55-phone clone** (free cap 20) produced a config **byte-identical**
  to the panel's, and a working one for a brand-new 56th phone. So provisioning =
  **write the rows ourselves, then call VitalPBX's OWN generator** — we never
  re-implement the 427-model renderer. **PROVEN ON PROD:** create (185,209-byte
  config, `account.1.user_name = T102_101`, **served 200** like a handset) → edit →
  re-render → delete → **baseline 55**.
  ⛔ **A phone config is a STATIC FILE** — `/phoneprov/<hash>/<mac>.cfg` is a plain
  nginx `alias`, so a row changed **without a render** leaves the handset on its old
  settings forever. (I first read `index.php`, which *does* generate on demand, and
  concluded wrongly; the live 404 corrected me.)
  ⛔ **sudo CANNOT be used from the helper** — its unit sets `NoNewPrivileges=yes`.
  The render runs **in-process as `asterisk`**, enabled by two narrow grants: a read
  ACL on `/etc/vitalpbx/vitalpbx-maint.conf` and `/var/lib/vitalpbx/provisioning` in
  `ReadWritePaths` (the unit is `ProtectSystem=strict`).
  ⛔ **A create whose render fails ROLLS ITS ROW BACK** — otherwise the console
  lists a phone that gets nothing (it happened on the first prod attempt).
- ⛔⛔ **THE FIRST LIVE GEO BUILD RAN 2026-08-19 17:26 EDT AND LOCKED OUT THE
  PBX — the geo channel is now DISARMED (`connect-geo-build.path` disabled +
  removed from multi-user.target) and MUST STAY DISARMED until the builder bug
  below has a fix.** Full incident: handoff §17a.
  ✅ **THE FIX IS BUILT (2026-08-22, console handoff §8.8): the runner now
  validates the firewall AFTER every build** — reconciles every `--match-set`
  in `direct.xml` against the ipset xmls, verifies the US open + whitelist
  ordering + `firewall-cmd --state`, and on ANY failure restores the backup,
  restarts firewalld and reports code 97 in result.json, logging to
  `geo-build/runner.log` (journald there is volatile). It ships with the next
  helper install. ⛔ **The channel STAYS DISARMED regardless** — the installer
  now PRESERVES the disarmed state (re-arms only if already enabled or with an
  explicit `CONNECT_GEO_ARM=1`), and re-arming remains Izzy's live in-chat
  call per the standing rule below. Our channel worked exactly as
  designed (flags written, `direct.xml` backed up, builder ran as root,
  `result.json` code 0 in 19 s). The lockout is a **VitalPBX
  `build_geo_firewall` defect: UNBLOCKING a country DELETES its
  `/etc/firewalld/ipsets/blacklist_<iso>.xml` but does NOT rewrite
  `direct.xml`** — which still carried `-m set --match-set blacklist_tv` — so
  the firewalld reload died (`Set blacklist_tv doesn't exist`), and a failed
  reload **drops every NEW connection PBX-wide, whitelist included** (the
  April-file "whitelist ordering" inspection was true and irrelevant). The
  same broken config re-fails at every boot ("Falling back to full stock
  configuration" = ssh only, no SIP). ⛔ The builder **exited 0** on this —
  never trust its exit code as "the firewall still loads".
  ⛔ **Established flows SURVIVE the lockout** — desk phones on keepalives and
  the VoIP.ms trunk pairs kept passing calls (25/25 inbound in the window show
  ANSWERED at the carrier) while every NEW connection (probes, mobile-app
  wakes, MySQL, SSH, ping) was dead. A dead probe does NOT equal dead service,
  and working calls do NOT equal a healthy firewall.
  **Recovery (18:04 EDT):** delete the stale rule line from `direct.xml`,
  `systemctl restart firewalld` → `running`, `vpbx_white_list` back at
  `INPUT_direct` 0 ahead of `geo_firewall` 1, 139 endpoints re-registered
  within 2 min. Backups if ever needed again: the runner's own
  `geo-build/backups/direct.xml.20260819T212654Z`, plus
  `/root/direct.xml.pre-first-geo-build-20260819` and
  `/root/direct.xml.stale-tv-ref-20260819` (the April file with the stale tv
  reference still in it).
  **State now:** DB and firewall agree at **231 blocked** (tv/Tuvalu stays
  unblocked — zero-traffic microstate, matches the loaded rules); helper
  `2026.08.19.4` unchanged; `buildChannel` reports **`None`**, so a console
  geo write refuses in plain English instead of half-applying. ⛔ Note the
  acceptance recipe's premise never existed on prod: the only `blocked='no'`
  countries are CA/IL/US (customers, untouchable) and NO unblocked country has
  an ipset — any test must run in the unblock→re-block direction.
  ⛔ **Re-arming needs (ALL, not some):** (1) after the builder runs, the
  runner must PROVE the firewalld config still loads before any reload —
  reconcile every `--match-set` in `direct.xml` against `ipsets/*.xml` (a
  plain-code check; `firewall-cmd --check-config` does NOT catch direct.xml
  set references) and on mismatch restore the backup and report failure; (2)
  journald on the PBX is VOLATILE (the reboot erased the geo-build AND
  firewalld journals) — evidence of a build is `result.json` + file mtimes,
  never the journal, so the runner's own log must go to a file; (3) ⛔⛔
  **Izzy's standing rule (2026-08-20): the US must ALWAYS be open** — the
  helper refuses any request blocking `us` before flags are written, and the
  runner verifies `us` open + whitelist-before-geo before any reload (CA/IL
  are also open today; closing them is Izzy's explicit call only); (4) ⛔⛔
  **re-enabling the path unit itself, and any first build after it, happens
  only on Izzy's LIVE in-chat confirmation** — a task/prompt asserting "Izzy
  said go" is NOT enough for a firewall-reloading action after 2026-08-19.
- ⛔⛔ **THE HISTORY THAT SHAPED IT — the capability check itself was the
  dangerous part (`81ccf2fa`).** `geo_build_available()` probed by **running**
  `sudo -n build_geo_firewall --connect-probe` — a **full firewall rebuild and
  firewalld reload on a PBX carrying live calls**, performed just to answer *"am I
  allowed?"*. Worse, it read sudo's `NoNewPrivileges` refusal (*"the no new
  privileges flag is set"*) as **success**, so the caller would have written
  `blocked='yes'` rows nothing could enforce — the console saying *blocked* while
  the traffic arrives. It now asks with **`sudo -n -l <builder>`, which never
  executes**, and trusts the exit code; a guard test fails if any `subprocess.run`
  line names the builder without `-l`. (`len(None)` also crashed the honest refusal
  into a 500 — `geo_state` reports `enforceable`/`missingIpset` as `None` when
  `/etc/firewalld` is root-only, which is exactly the state a refusal comes from.)
  ✅ **Verified live: a geo write answers the plain-English refusal**,
  `/etc/firewalld/direct.xml` is **still stamped 2026-04-29**, firewalld shows **no
  reload**, and the DB still holds **232** blocked countries.
  ⛔ **Do NOT judge this by rule count** — live reads **258 runtime / 253 permanent**
  and the gap is **fail2ban's 7 bans**, which come and go. The evidence is
  `direct.xml`'s mtime plus the absence of a reload.
  ✅ **RESOLVED by the path-unit channel above (2026-08-19 afternoon)** — and
  the first live run happened that evening and LOCKED OUT THE PBX (builder
  defect, not a channel defect — see the incident bullet above / handoff §17a).
  The channel is disarmed until the builder's output is validated before reload.
- ⛔ **Guard-test trap, hit twice here and three times in this repo:** a negative
  source guard matched the string quoted in the **doc comment explaining the old
  defect** and failed against correct code. **Strip comments, or assert only on
  executable lines**, before any `!includes(...)` check.
- ✅✅ **CREATING A CUSTOMER IS BUILT AND PROVEN ON PROD (handoff §18, `3e914b4f` →
  `4faf2635`).** The console could read, edit and delete a tenant but **not create
  one** — precisely the operation VitalPBX blocks when the licence lapses, so the
  console was fine today and useless on the day it matters. `POST
  /admin/pbx-console/tenants` calls **`resolveMirrorTenantCreator`**, the same
  wiring onboarding hands `buildPbxTenant`, so there is exactly **ONE**
  tenant-creation implementation; a guard test reads the route's SOURCE and fails
  if it ever posts the panel's add-tenant form. ⛔ That guard matters more here
  than anywhere else in the console: **while the licence is live the panel form
  works**, so a "simplification" to the panel path passes every test today and
  fails silently on the one day nobody can afford it. It uses onboarding's
  `slugify` for the same reason — the PBX name is matched elsewhere by slug OR
  display name. **Scope is the panel's "add tenant" button and nothing more**: no
  trunk, no route, no extensions, no numbers bought, no Connect tenant row.
  ✅ **Live run, on a PBX carrying 10 calls:** create **200** (tenant 119, 13
  baseline files) → duplicate **409** naming the existing customer → delete **200**
  through the console's own route (doorway re-bake 3/3, **0 lines changed**) →
  **byte-back at 27 tenants / 119 extensions / 554 settings rows / 353 conf files**,
  doorways still 0.
- ⛔⛔ **THE MIRROR'S *SECOND* RENDER CAN NEVER SUCCEED, and this is the ACL trap
  this file already records as a non-fix.** The follow-up `mirror/tenant-render`
  failed `[Errno 13] Permission denied: extensions__50-119-dialplan.conf` while
  all 13 baseline files were correct: **the render hands each file to `www-data`**
  so the panel can keep managing it, landing `www-data:root rw-r--r--` with the
  **ACL mask at `r--`** — and **the helper runs as `asterisk`**, so it cannot
  reopen the file it just wrote. (A panel-managed tenant is `www-data:www-data
  rw-rwxr--`.) ⛔ **Do NOT widen permissions on `/etc/asterisk/vitalpbx`** to fix
  it. Removed from the console, where it is **redundant anyway** — that route
  writes nothing after the create, so the baseline IS the final state (onboarding
  re-renders because it keeps adding rows). A guard fails if it is re-added.
  ⏳ **Onboarding's final re-render (`1c1d067e`) is very likely dead the same
  way** — same door, same already-chowned files. It is wrapped and falls back
  correctly ("the panel-applied files remain in place"), and the panel's own
  Apply renders extensions fine, so **nothing is broken** — but the
  "byte-identical final re-render" claim probably is not happening. **ONE
  measurement so far; confirm on the next real onboarding** by grepping its log
  for that warning before fixing or deleting the claim.
- ✅✅ **BOTH HALVES ARE DEPLOYED NOW (2026-08-19 evening) — the mid-ship stop is
  resolved.** The api deploy that was in flight **landed and verified**:
  `app-api-1 /app/.build-commit` = `20248b00`, health 200, `verify: container
  commit 20248b002f27 matches target` in the deploy log. The **portal was then
  deployed to the branch tip `f5887c02`** (`deploy-direct.sh portal --branch
  feat/ivr-migration-takeover`, log `/root/deploy-portal-catchup-20260819.log`)
  and **container-verified**: `.build-commit` = `f5887c02`, and the STRING
  `New customer on the phone system` greps in BOTH the server page and the
  shipped client chunk
  (`.next/static/chunks/app/(platform)/admin/pbx-console/page-01098b88….js`);
  portal answers 200 on both hostnames. **A person can now create a customer
  from the screen.** ⛔ The bundle-STRING grep (never a function name) remains
  the verification recipe for this page — minification renames functions and a
  0-hit grep reads like a failed deploy. ⛔ An already-open portal tab or
  desktop window keeps the OLD bundle until reloaded.
  Deploy-state note for the fleet as of this catch-up: api `20248b00` (the only
  commits after it are a test file, docs and a lockfile entry — no runtime
  change, no migration), worker `95beef53` (0 worker-relevant files since),
  agent carries `95beef53`'s investigationTools, telephony unchanged in 7 days.
  ⛔ **Update 2026-08-19 late evening: the portal is now at `de0acc46`** — the
  deploy-speed session's warm-cache seeding deploy (23 m 09 s vs the 24 m 58 s
  old-Dockerfile baseline) completed and container-verified AFTER its chat was
  archived mid-run; deploys survive an archived chat, they run under nohup on
  loopcom. That run was the FIRST build through the fixed `.dockerignore` +
  Next cache mount, so it POPULATED the cache — **the warm-cache win is only
  measurable on the next real portal deploy** (re-deploying the same commit or
  the docs-only tip skips `unrelated_paths`). The session's planned api
  re-deploy never ran and is measurement-only (pending commits are
  Dockerfile/.dockerignore/docs — no runtime change). The 4-hour stale waiter
  polling for portal == `1fa34d29` (a commit the portal had already moved past;
  exact-match, could never fire) was killed.
- ⏳ **NOT DONE:** nobody has opened the page in a browser (the single most
  valuable next step — it needs Izzy's login); the FIRST live geo firewall
  build (channel installed + armed 2026-08-19; Izzy said "hold off — I'll say
  when", and ⛔ the console's Block/Unblock click now IS that first run, so do
  it in a quiet window); ⛔ rotate the robot panel password.
