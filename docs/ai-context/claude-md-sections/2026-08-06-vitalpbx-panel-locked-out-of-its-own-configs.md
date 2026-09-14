# ⛔ AGENT HANDOFF — VitalPBX panel locked out of its own configs (2026-08-06) — READ FIRST for "An exception has occurred / file_put_contents Permission denied" in the panel, tenant conf ownership, or the helper's privileges

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PBX_PANEL_LOCKOUT_2026-08-06.md`**
(commits `fc826643` helper-side + `2f017f88` privilege/installer-side — both now
pushed to `origin/feat/ivr-migration-takeover`).

- **Symptom**: red modal on any panel Save for one tenant —
  `file_put_contents(/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf):
  Permission denied` (OmbuSystemConf.php) — while the green "data has been
  updated in the database" toast is simultaneously CORRECT. The DB write lands;
  only the live routing file write fails, so the change needs a re-save after
  the fix. ⛔ **Calls are never affected** (Asterisk only READS these, mode 644).
  Hit tenants 2 (`a_plus_center`) and 35 (`connect_communications`).
- ⛔ **ROOT CAUSE — the fix already existed and could not run.** `fc826643`
  added `_chown_gui_conf` / `restore_gui_conf_ownership` to hand each
  regenerated conf back to www-data, and it shipped in the deployed helper.
  But `connect-pbx-helper.service` runs `User=asterisk`, and **handing a file
  to another user is root-only** — every call raised `PermissionError` into a
  deliberate "never raises" swallow. Live-proven: manual chown at 21:41,
  re-broken at 22:09, the exact minute the helper *carrying the fix* installed.
  **The code was never wrong; the privilege was missing.**
- **Real fix**: drop-in
  `/etc/systemd/system/connect-pbx-helper.service.d/10-gui-conf-ownership.conf`
  granting `AmbientCapabilities=CAP_CHOWN CAP_FOWNER` (+ matching
  CapabilityBoundingSet) — still NOT root. Applied live, verified via
  `getpcaps`, and added to the installer. Unit backup
  `/root/connect-pbx-helper.service.bak-20260806-ownership`.
- ⛔ **Two non-fixes — do not retry**: a one-off `chown` (right emergency move,
  but the next regen re-takes it), and **a POSIX ACL alone** (the regen's
  `chmod 0644` sets the ACL *mask* to `r--`, masking `www-data:rw-` to
  effective `r--` — verified with a probe file).
- **Canary kept**: `connect-conf-owner-heal.{path,timer}` +
  `/usr/local/sbin/connect-vitalpbx-conf-owner-heal.sh`. It should now NEVER
  fire — new entries in `journalctl -t connect-conf-heal` mean the capability
  grant regressed.
- ⛔ **The installer would have DOWNGRADED the PBX**: its embedded helper had
  drifted to `2026.08.06.2` while the `.py`/live PBX were `2026.08.06.6`, so a
  reinstall would have wiped the same day's doorway-hijack fix (`db4a2ce4`).
  Re-synced. The `fc826643` drift guard catches this **only if someone runs
  it** — and on Windows it could not pass at all (`core.autocrlf` → `.sh` CRLF
  vs `.py` LF), now pinned by a new `.gitattributes` (`/scripts/pbx/**
  text eol=lf`, scoped — a repo-wide `*.sh` rule would churn 113 files).
  Run the guard after ANY change to either file — it is 33 node:test cases,
  ~1 s: `npx tsx --test scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts`
  (green as of 2026-08-06, both files at `2026.08.06.6`).
- **Where the ownership code lives** (`fc826643`, four call sites — all four
  matter): `restore_gui_conf_ownership()` runs after a successful
  `apply_tenant_changes()` regen and BEFORE the MOH re-apply, and
  `_chown_gui_conf()` runs after `os.replace` in each of the three atomic
  tenant-conf writers (queue musicclass patch, dialplan MOH patch, route-Goto
  bake). All are tenant-scoped and non-fatal by design — with the capability
  grant in place they now actually take effect.
- Env: the helper's `audit.jsonl` is `/var/lib/connect-pbx-helper/` (**66 GB**,
  `tail -c` only) — NOT `/opt/connect-pbx-helper/`. Multiple sessions edit the
  SAME working tree concurrently: stage explicit paths, never `git add -A`.
