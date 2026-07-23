# X4 — Tenant MOH publish must cover QUEUES — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Blocks: M1 · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. The requirement (Izzy, 2026-07-23)

"When a tenant changes all music on hold, the queues should change as well."
One publish = inbound + outbound + **every queue** of that tenant. No separate
manual queue step, ever.

## 2. Root cause — CONFIRMED on the live PBX (read-only audit, 2026-07-23)

How queue hold music actually works on VitalPBX 4.5.3 (vmi2718844):

1. A queue's music is the `musicclass=` line in its generated config file
   (`/etc/asterisk/vitalpbx/queues__50-<tenant>-*.conf`), rendered from
   `ombu_queues.music_group_id`. (T21's new "me testy" queue 1121: group 1 →
   `musicclass=default` at line 13 of `queues__50-21-main.conf`.)
2. Connect's MOH publish already calls the route helper, and the installed
   helper (May 11 build, `/opt/connect-pbx-helper/`) **does update
   `ombu_queues.music_group_id`** for the tenant…
3. …but its apply step runs only `dialplan reload` + `moh reload`
   (`CONNECT_PBX_HELPER_APPLY_COMMAND='asterisk -rx "dialplan reload"'`).
   **Neither regenerates the queue config file nor reloads app_queue.** The DB
   is right; the running queue keeps the old class until a GUI edit forces a
   regen. That GUI edit is exactly the manual step Izzy does today.
4. The per-call enforcement layer (`extensions__65_connect_tenant_moh.conf`)
   can't help queues: it hooks *before-bridging*, and a queued caller isn't
   bridged yet; the helper's own code comment documents that queue music comes
   from queues.conf, not the channel override.
5. `force_moh` is not the lever — VitalPBX docs: it overrides MOH *on the
   agent/transfer side*, not the waiting caller's class.
6. Note: all current tenant MOH classes on this box are NATIVE music groups
   (`ombu_music_groups` → classes like `moh8`; Connect syncs them via the
   existing ombutel class sync). The `connect_*`-asset class path
   (`musiconhold__99_connect_assets.conf`) is not present/in use on the box
   today, so X4 v1 fixes the native path — the path every tenant actually uses.

## 3. The fix — H-series helper update (H1), hand-installed by Izzy

Extend the helper's existing tenant-MOH sync so that AFTER it updates
`ombu_queues.music_group_id` (code that already exists and runs today):

1. **Patch the tenant's generated queue config in place** — for each affected
   queue file `queues__50-<tenant>-*.conf`, rewrite ONLY the `musicclass=` line
   to the new class name, with:
   - a strict regex (`^musicclass=…$` inside that tenant's files only),
   - a timestamped backup of each touched file,
   - a post-write diff check (exactly N lines changed, nothing else).
   The file then matches what VitalPBX's own regeneration would produce from
   the already-updated DB row — we converge the runtime file to the DB, we do
   NOT run config generation. **No `gen-conf`, no June-incident-class regen.**
2. **`asterisk -rx "queue reload all"`** so app_queue picks it up (parameters
   reload; waiting callers keep position — same reload the GUI edit triggers).
3. **Report per-queue evidence** in the helper response (queue id, file, old
   class → new class, reload result) — Connect stores it on the publish record;
   M1's verify step will require it.
4. Rollback: the same mechanism in reverse (previous group id is already in the
   publish snapshot; re-patch + reload). File backups are belt-and-suspenders.

Delivery discipline (audit Path-2): helper source updated in the repo installer
(`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`), reviewed by Izzy,
**installed on the PBX by Izzy by re-running the installer** — the agent never
installs its own bridges. The Connect publish path needs NO code change (it
already calls this helper sync and stores its response).

### Alternatives considered and rejected
- **Scoped VitalPBX regen** of queue configs: regen is the June-2026 incident
  class; rejected while a regen-free patch produces the identical file content.
- **`force_moh` flag:** wrong semantics (agent-side), confirmed from docs.
- **Channel-override before Queue():** unreachable — enforcement hook fires at
  bridge time, queued callers aren't bridged.

## 4. SEBA — Side-Effect & Blast-Radius Analysis

**(a) Touched on each publish:** `ombu_queues.music_group_id` rows for ONE
tenant (already happens today), that tenant's `queues__50-<tenant>-*.conf`
`musicclass=` lines only (new), one `queue reload all` (new), helper response
JSON (new fields).
**(b) Other readers:** app_queue (the point); VitalPBX GUI reads the DB (already
updated — file now agrees with GUI instead of disagreeing); future VitalPBX
regens produce the same content we wrote.
**(c) Calls in flight:** `queue reload all` reloads queue parameters — callers
already waiting keep their position and their current music stream; the next
hold/join uses the new class. Identical to today's GUI-edit behavior.
**(d) Dies halfway:** DB updated + file not patched = today's status quo (worker
retries next publish); file patched + reload failed = helper reports nonzero
exit, publish records the failure, M1 verify fails ⇒ X1 auto-revert; backups
allow manual restore of any touched file.
**(e) Fan-out proof:** file glob is tenant-scoped (`queues__50-<tenant>-*`),
queue UPDATE is tenant-scoped (existing WHERE tenant_id), and the reload is the
same one the GUI causes routinely. Other tenants' files are never opened.
**Worst case ceiling:** one tenant's queues play wrong/old music until revert —
plus pre-patch backups on disk.

## 5. Test plan

- **UNIT (helper, repo-side):** musicclass patch function against fixture conf
  files — exact-line replacement, multi-queue tenant, zero-match (no queues),
  refuses to touch out-of-tenant files, backup+diff accounting.
- **SIM-CERT:** Connect-side publish path consumes the new helper evidence
  fields (queuesPatched, reload exitCode) and surfaces them on the publish
  record; simulated helper responses (success / patch-fail / reload-fail).
- **RED-TEAM:** crafted tenant id / glob-injection attempts into the patch path
  (helper validates `^\d+$` tenant, fixed directory, fixed filename pattern).
- **STRESS:** publish flip A→B→A ×10 against a fixture conf tree — files stay
  byte-stable except the one line; backup rotation bounded.
- **LIVE-CERT (T21 only, Izzy at each step):**
  1. Izzy reviews the helper diff and re-runs the installer on the PBX;
  2. baseline: read queue 1121's conf line + DB row (read-only);
  3. portal MOH change on T21 (normal portal flow, no agent involved) →
     confirm DB row, conf line, `queue show` class all changed together;
  4. **hearing check:** call into queue 1121, hear the new music;
  5. flip back; hearing check again;
  6. verify another tenant's queue files' mtimes are untouched.
- **REVERT-DRILL:** restore one queue file from its helper backup + reload;
  confirm identical to pre-change state.

## 6. Decisions — ANSWERED (Izzy, 2026-07-23) → SPEC SIGNED OFF

1. Regen-free patch + queue reload approach: **APPROVED**.
2. Installation workflow — **AMENDED BY IZZY: one-time explicit permission for
   the agent (Claude) to install this helper update directly on the PBX**, with
   maximum care. This is a single-occasion exception to the read-only PBX rule,
   for this change only; it does NOT generalize to any future change. Extra
   safety obligations attached: pre-install diff against the INSTALLED helper
   (not just the repo copy), timestamped backups of every touched file, install
   verified by checksum, service health-check after restart, full evidence log.
3. v1 scope = native-class publishes: **APPROVED** (connect_* asset classes get
   their own item if/when they go live).
