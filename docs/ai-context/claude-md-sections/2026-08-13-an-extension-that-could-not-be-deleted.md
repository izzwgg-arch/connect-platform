# ⛔ AGENT HANDOFF — an extension that could not be deleted (2026-08-13) — READ FIRST for any red "Fatal error … delete() on null" in the VitalPBX panel, before deleting ANY extension, or before assuming a panel fatal is chronic

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_EXTENSION_DELETE_MOBILE_FLAG_2026-08-13.md`**
(doc committed + pushed as `32115851` on `feat/ivr-migration-takeover`.
**PBX data repair only** — one `UPDATE` of one column on one row. No code, no
deploy, no regeneration, no reload. Read-only everywhere else.)

- ⛔ **An extension whose device row says `mobile_client='yes'` while having NO
  row in `ombutel.ombu_mobile_devices` CANNOT be deleted.** `Extension->delete()`
  calls `_deleteMobileAccount()`, gets `null`, and fatals — the panel dies with
  `Call to a member function delete() on null`, **naming no extension**, so it
  reads like a broken panel rather than one bad record. Nothing is deleted and
  nothing is half-deleted (verified: DB rows, pjsip endpoint, hints and mailbox
  all intact after eight attempts). ⛔ `Extension.php` is **ionCube-encrypted** —
  judge it from the DB, the generated config and `/var/log/nginx/error.log`, and
  don't waste time trying to read it.
- **The one query that scopes it fleet-wide** (read-only): left-join
  `ombu_devices` to `ombu_mobile_devices` on `device_id` where
  `mobile_client='yes' and m.id is null`. **Empty = no extension on the box has
  this fault.** On 2026-08-13 it returned exactly ONE row across all 27 tenants —
  device 171, Secro Selutions ext 103 "Fix Up Group" — and returns empty now.
- **The fix is to make the record honest:** `update ombutel.ombu_devices set
  mobile_client='no' where device_id=<id>`. ⛔ **Do NOT fix it through the panel**
  — toggling Mobile Client to No and pressing Update *is* "delete the mobile
  account", so it very likely hits the same crash. ⛔ **The flag is inert to call
  handling, proven not assumed**: the generated `[T3_103]` pjsip block is
  identical to an unflagged extension's apart from `callerid`, which is why **no
  regeneration and no reload** were needed. Backup
  `/root/ombu_devices_171_backup_20260813.sql`.
- ⛔ **`deleteMobileAccount` appears nowhere else in the nginx error log's
  history** — all 8 fatals were Izzy's own attempts, 11:30–12:03 ET the same day.
  **Grep the log's whole history before calling a panel fatal chronic.**
- **Before deleting any extension, check what dies with it.** For 103: no
  `ombu_destinations` row with `module_id=1, index=130` and the tenant's DID goes
  to a time condition, so no route breaks — but it IS the **only member of ring
  group 822**, which would be left empty. ⛔ `ombu_destinations` is
  `(id, category_id, module_id, index)` where `index` is the target row's id
  within that module; module **1** = extensions, **20** = ring_group,
  **29** = inbound_route.
- ⛔ **Deleting on the PBX does not stop the billing** — Connect keeps its own
  `Extension` row, still billable, still on the invoice, still in the app's Team
  list. **OPEN, flagged to Izzy, not investigated:** Connect bills Secro
  Selutions for **6** extensions at $25 while the PBX holds **3** — 305, 306 and
  307 exist only in Connect.
- ⏳ **NOT PROVEN: nobody has pressed Delete since the repair.** It is proven as
  data (orphan query empty, flag matches reality), not as a completed delete.
- ⛔⛔ **THE DATES IN THAT HANDOFF ARE NOT TRUSTWORTHY — a SECOND sighting of the
  clock problem, and it is UNRESOLVED (§10 of the handoff).** The PBX log stamps
  the incident `2026/08/13 11:30–12:03` and this workstation stamped the doc
  commit `2026-08-13 12:56`, while parallel sessions stamped their commits
  `2026-08-16 13:51–14:12` the same afternoon — yet at session end **all three
  machines agreed on 2026-08-16 18:13 UTC**, NTP-synced. Evidence on both sides
  (an unbroken Aug 2→16 rotation sequence vs. three rotation files appearing
  mid-session) **contradicts itself and the contradiction stands.** The repair is
  unaffected — it rests on DB state and generated config, never on a clock — but
  **do not build a timeline on these timestamps.**
  ⛔ **The git trap this produced: `git log --oneline -3` did NOT show the commit**
  while `git merge-base --is-ancestor` said it was in HEAD, `git ls-tree HEAD`
  listed the file and `git branch -r --contains` put it on origin. **A
  date-skewed commit sinks below newer ones and reads exactly like a lost commit
  or a branch rollback.** Verify with `--is-ancestor` / `ls-tree`, never by
  eyeballing the log.
