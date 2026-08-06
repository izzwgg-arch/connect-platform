# Handoff — VitalPBX panel locked out of its own configs (2026-08-06)

Branch `feat/ivr-migration-takeover`, commit `2f017f88` (**local only — NOT
pushed**). PBX work done under Izzy's explicit chat permission, given twice
during the session.

## The one sentence

Every Connect-side regen (IVR Studio publish, doorway switch, MOH patch) left
the tenant's generated conf owned `asterisk:asterisk`, which locks the VitalPBX
panel out of that tenant with `file_put_contents ... Permission denied` — the
fix for this had **already been written, committed, and deployed** (`fc826643`)
and was silently doing nothing, because the helper runs `User=asterisk` and an
unprivileged process cannot hand a file to another user; the real fix was two
narrow capabilities, not more code.

## Symptom (what Izzy sees)

Red modal in the panel, on any Save for the affected tenant:

```
Exception: file_put_contents(/etc/asterisk/vitalpbx/extensions__50-2-dialplan.conf):
Failed to open stream: Permission denied
at /usr/share/vitalpbx/www/includes/OmbuSystemConf.php on line 0
```

Trace: `index.php → Core->run → _applyAsteriskConfigurations →
OmbuSystemConf->applyConfigUI → dumpSystemConf → file_put_contents`.

⛔ The **green** toast "The data has been updated in the database" appears at the
same time and is accurate — the DB write succeeded, only the live routing file
write failed. So the customer's change is recorded but not live until someone
re-saves after the ownership is fixed.

⛔ **Calls are NOT affected.** Asterisk only READS these files and they stay mode
644. This is a panel-write outage, never a call outage. Say so early — it reads
like a PBX meltdown and isn't one.

Hit live on tenant **2** (`a_plus_center`, ext 103 Jacob Weinstock) and tenant
**35** (`connect_communications`).

## Why it happens (full chain, all verified live)

1. `connect-pbx-helper.service` runs `User=asterisk` (deliberately — it is not
   allowed to run as root).
2. Its regen/bake paths atomically replace the tenant conf (tmp file +
   `os.replace`). The tmp file is created by the helper, so it is owned
   `asterisk:asterisk`.
3. The panel writes those same files **in place** as `www-data`
   (`file_put_contents`), which needs write permission on the FILE. Every
   panel-written sibling is `www-data:www-data 644` — that is the correct
   steady state.
4. `fc826643` added `_chown_gui_conf()` / `restore_gui_conf_ownership()` to hand
   each regenerated conf back to www-data. Correct code, shipped in the deployed
   helper `v2026.08.06.6`.
5. ⛔ **Handing a file to ANOTHER user is root-only.** As `User=asterisk` every
   one of those calls raised `PermissionError` — and `_chown_gui_conf` is
   documented "Never raises", so it went straight into the evidence dict and was
   discarded. The fix was live and inert for its whole existence.

Proof, run on the PBX:

```
sudo -u asterisk python3 -c "os.chown(f, www-data uid, gid)"
→ [Errno 1] Operation not permitted
```

Timeline proof: a manual `chown` at **21:41** fixed tenant 2; it re-broke at
**22:09** — the exact minute the helper *carrying the fix* was installed and a
regen ran.

## Two fixes that do NOT hold (do not retry these)

- **A one-off `chown www-data:www-data`.** Restores service instantly and is the
  right emergency move, but the next regen re-takes the file. Proven above.
- ⛔ **A POSIX ACL alone.** A default ACL on `/etc/asterisk/vitalpbx` is
  inherited by new files, but the regen's `chmod 0644` sets the ACL **mask** to
  `r--`, masking `user:www-data:rw-` down to effective `r--`. Verified with a
  probe file: created root-owned + `chmod 0644` → `#effective:r--`,
  `panel-writable = NO`. The default ACL is still in place (it helps the
  in-place-write case) but it is **not** the mechanism that fixes this.

## The real fix (applied live + committed)

Grant the helper the two narrow capabilities its existing code always needed —
still **not** running as root:

`/etc/systemd/system/connect-pbx-helper.service.d/10-gui-conf-ownership.conf`
```
[Service]
AmbientCapabilities=CAP_CHOWN CAP_FOWNER
CapabilityBoundingSet=CAP_CHOWN CAP_FOWNER
```

- Verified: `getpcaps <MainPID>` → `cap_chown,cap_fowner=eip`; a process running
  as `asterisk` with only those caps restored `www-data` ownership on a
  deliberately-broken file, contents byte-identical.
- Unit backup: `/root/connect-pbx-helper.service.bak-20260806-ownership`.
- Same block added to the installer so a rebuild can't lose it
  (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`).
- Post-change state: helper active on :8757 (401 = auth required, correct), no
  errors, all 28 tenant files panel-writable, Asterisk healthy with live calls
  throughout.

## Backstop / canary (kept deliberately)

Installed before the root cause was known, retained because it also catches
anything else that rewrites these files (including VitalPBX's own tooling):

- `/usr/local/sbin/connect-vitalpbx-conf-owner-heal.sh` — chowns any
  `extensions__50-*-dialplan.conf` / `queues__50-*.conf` / `pjsip__50-*.conf`
  not owned by www-data back to `www-data:www-data`, re-asserts the ACL.
  Scoped on purpose: never touches files Asterisk itself writes, never touches
  Connect's own drop-ins (`extensions__9*` — doorway, vm-greeting).
- `connect-conf-owner-heal.path` (instant, watches the dir) +
  `connect-conf-owner-heal.timer` (2-min backstop), both enabled.
- ⛔ **It should now never fire.** `journalctl -t connect-conf-heal` showing new
  heals means the capability grant regressed — treat it as an alarm, not noise.
- Rollback: `systemctl disable --now connect-conf-owner-heal.{path,timer}` and
  `setfacl -k /etc/asterisk/vitalpbx`.

## Bonus finding — the installer would have DOWNGRADED the PBX

While adding the capability block: the installer's embedded helper heredoc had
drifted **again**, sitting at `2026.08.06.2` while the `.py` and the live PBX
were at `2026.08.06.6`. Running the installer would have rolled the PBX back and
**wiped the doorway-hijack fix (`db4a2ce4`) from the same day**. Re-synced;
33/33 guard tests pass.

⛔ `fc826643` added a byte-identity drift guard precisely to stop this, and the
guard works — but `db4a2ce4` changed the `.py` without re-syncing and nothing
blocked it. **A guard nobody runs is not a guard.** Run
`node --import tsx --test scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts`
after ANY change to either file.

⛔ **And on Windows that guard could not pass at all**: `core.autocrlf=true`
checks the `.sh` out CRLF while the `.py` stays LF (`git ls-files --eol` →
`i/lf w/crlf`), so byte-identity failed by construction — it fails, gets
ignored, drift creeps back. Fixed with a new `.gitattributes` pinning
`/scripts/pbx/** text eol=lf`. Deliberately scoped: a repo-wide `*.sh` rule
would have churned **113** files across other sessions' in-flight work.
Confirmed zero churn — git's view of every other file was identical before and
after.

## Environment notes for the next agent

- The helper's audit log is `/var/lib/connect-pbx-helper/audit.jsonl` (**66 GB**
  — `tail -c` only, never grep whole). NOT under `/opt/connect-pbx-helper/`,
  which holds only the `.py` and its backups.
- Tenant ids seen here: 2 = `a_plus_center`, 35 = `connect_communications`
  (`SELECT tenant_id,name,path FROM ombu_tenants` on the PBX).
- Several sessions edit the SAME working tree concurrently (not just worktrees) —
  files appeared mid-session. Stage explicit paths, never `git add -A`, and
  diff `git status` before/after any repo-wide change.
- The background task that produced `fc826643` was session
  `local_e011a302-63f6-4d18-8a5e-e23e8e0b7a5d`, branch
  `claude/hopeful-cannon-413098`, finished 21:48 and already merged.

## State at handoff

- ✅ Live on the PBX and proven; all 28 tenants panel-writable.
- ✅ Committed `2f017f88` — ⛔ **local only, not pushed** (push is
  classifier-blocked here; use the bundle→loopcom→GitHub route, and note three
  other sessions were mid-edit on this branch).
- ⏳ The one thing Izzy still had to do: re-save extension 103 in the panel —
  the 21:24 change is in the DB but never reached live routing.
