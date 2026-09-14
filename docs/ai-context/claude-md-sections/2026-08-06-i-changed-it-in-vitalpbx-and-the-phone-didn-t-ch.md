# ⛔ AGENT HANDOFF — "I changed it in VitalPBX and the phone didn't change" (2026-08-06) — READ FIRST for BLF/key edits, desk-phone provisioning, or before believing a phone's registration proves anything

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATEABOX_102_BLF_MAC_2026-08-06.md`**
(Create A Box ext 102 — FIXED and verified live under Izzy's one-time PBX write mandate,
scoped to that one extension; backups `/root/blf-102-backup-20260806/`.)

- ⛔ **VitalPBX provisioning is PRE-GENERATED FILES, rendered at SAVE time.** It never
  looks a phone up when the phone asks. Saving writes
  `/var/lib/vitalpbx/provisioning/provisioning_templates/<tenant-hash>/<mac>.cfg`, and
  nginx hands out whatever filename is requested. So a **wrong MAC on the record rewrites
  a file nothing downloads**, while the phone keeps downloading its own file — with a
  clean **200**, never a 404. Ext 102's phone served a **July 19** copy for seven weeks:
  right account, right password, **zero BLF keys**. Proven by mtimes: he saved 101 at
  12:26:15 and 101's phone got it 29 s later (**that one worked**), saved 102 at 12:41:20,
  then resynced 102 four times and got the stale file every time.
- ⛔ **"It registers, so its MAC must be in the system" is FALSE — the MAC plays no part in
  registration.** `[T7_102]` is `identify_by=username,auth_username`; there are **zero**
  MACs in the tenant SIP config, and across `ombutel`+`asterisk` the only `mac` column is
  `ombu_static_leases` (DHCP). `ombu_devices` has **no MAC column at all**. The phone keeps
  its credentials locally. ⛔ The WireGuard tunnel is irrelevant to both — it is only the
  road the traffic travels.
- **THE DIAGNOSTIC, one grep:** `grep phoneprov /var/log/nginx/access.log` (+ zgrep the
  .gz). Every download logs the phone's **own MAC in its User-Agent**; compare it to the
  record, then `stat` that `<mac>.cfg`. Fetched but **mtime predates your edit** = wrong
  MAC (this case). **No fetch at all** = the phone never asked — fire the check-sync, see
  [[createabox-102-blf-mac-mismatch]]. A hit from **127.0.0.1 / UA "VitalPBX"** is
  just the panel rendering a page and proves nothing.
- **Fix + proof shape:** correct the MAC on the record (durable — future saves land right),
  overwrite the phone-facing `.cfg` with the correct render for an immediate fix, then
  `pjsip send notify yealink-check-cfg endpoint T<t>_<ext>` (⛔ NOT the reboot button).
  ⛔ **Diff the two configs before overwriting** — ours differed only in the key blocks with
  a byte-identical account block; a differing password would knock the phone offline. ⛔ Use
  `cat src > dest`, never `cp` — that dir carries POSIX ACLs (`+` in `ls -la`). Verified by
  the served size changing **138162 → 138270** 1 s after the NOTIFY, plus **5 BLF
  subscriptions** (101/103/105/106/107) appearing in `pjsip show subscriptions inbound`.
- ⛔ **Do not suppress stderr on probes** — an early `mysqldump … 2>/dev/null | grep` would
  have made a failed dump read as "the MAC isn't in the database". Re-run visibly before
  trusting a negative. Config key lines are **indented**, so `grep "^linekey"` finds
  nothing and looks like "no BLFs anywhere".
- A trailing space in `linekey.2.value` (`103 `) was called a likely dead key and that was
  **wrong** — Yealink trims it, 103 subscribed normally. Left as Izzy wrote it.
- ✅ The staged registration-expiry fix from the T7 outage handoff (2026-08-05 §4) is
  **confirmed applied** — all seven T7 aors read `default_expiration/maximum_expiration
  120`. ⏳ Ext **104 and 106 are not registered** (101/102/103/105/107 Avail) — flagged to
  Izzy, not investigated.
