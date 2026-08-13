# AGENT HANDOFF — an extension that could not be deleted (2026-08-13)

**Scope: PBX data repair only.** One `UPDATE` of one column on one row. No code
change, no deploy, no config regeneration, no reload, no Connect-side change.
Read-only everywhere else.

Symptom Izzy hit: pressing **Delete** on Secro Selutions ext 103 "Fix Up Group"
in the VitalPBX panel produced a red modal —

```
Fatal error: Uncaught Error: Call to a member function delete() on null in
/usr/share/vitalpbx/www/modules/extensions/Models/Extension.php:0
Stack trace:
#0 ... modules\extensions\Models\Extension->_deleteMobileAccount()
#1 ... modules\extensions\Models\Extension->delete()
#2 ... modules\extensions\extensions->delete()
...
```

---

## 1. Root cause

The device row behind ext 103 was flagged **`mobile_client = 'yes'`** while
having **no row at all** in `ombutel.ombu_mobile_devices`.

`Extension->delete()` runs `_deleteMobileAccount()`, which looks the mobile
account up, gets `null`, and calls `->delete()` on it. PHP fatals and the whole
request dies.

**The record was lying about itself** — the checkbox claimed a mobile account
that did not exist.

⛔ `Extension.php` is **ionCube-encrypted** and cannot be read. Everything here
is established from the database, the generated Asterisk config, and
`/var/log/nginx/error.log`. Do not waste time trying to read the model.

### Why the crash is gated on the flag (and why the fix works)

Unverifiable directly (encrypted source), but: if `_deleteMobileAccount()` were
called unconditionally, **every** extension delete on this box would fatal, and
deletes demonstrably work (the 2026-08-06 inii mini renumber is
copy → re-point DID → **delete**). So the call is gated on `mobile_client`, and
clearing the flag routes the delete around the crash.

---

## 2. Scope — it was exactly one record

Fleet-wide check across all 27 tenants:

```sql
select d.device_id, d.tenant_id, d.user, d.description
from ombutel.ombu_devices d
left join ombutel.ombu_mobile_devices m on m.device_id = d.device_id
where d.mobile_client = 'yes' and m.id is null;
```

**Before the fix: exactly one row** — device_id 171, tenant 3, user `103`,
"Fix Up Group ". **After: empty.** 31 mobile accounts exist platform-wide and
every other one has its matching row.

Tenant 3 for context:

| device_id | user  | description     | mobile_client | mobile row |
|-----------|-------|-----------------|---------------|------------|
| 12        | 301   | Gitty           | no            | —          |
| 13        | 302   | Hendy           | yes           | 92         |
| 77        | 301_1 | Gitty Oppenheim | no            | —          |
| 160       | 302_1 | Hendy           | no            | —          |
| **171**   | **103** | **Fix Up Group** | **yes**    | **MISSING**|

**How it got that way is not established.** The flag was set and the account row
either never got created or was later removed. There is no audit trail on the
PBX for this. What *is* established is that it is not systemic and not recurring.

---

## 3. Timeline (from `/var/log/nginx/error.log`)

Eight fatals, all 2026-08-13: `11:30:15, 11:30:17, 11:30:38, 11:30:40, 11:30:41,
11:30:42, 11:31:33, 12:03:21`. Those are Izzy's eight attempts.

⛔ **The string `deleteMobileAccount` appears nowhere else in that log's
history** — this was a fresh one-off, not a long-running quiet failure. That is
the check to run before assuming a panel fatal is chronic.

---

## 4. Nothing was half-deleted

The crash happens **before** anything is removed. Verified intact after the
eight attempts:

- `ombu_extensions` row 130 (ext 103, tenant 3) — present
- `ombu_devices` row 171 — present
- `pjsip__50-3-extensions.conf` — `[T3_103]` endpoint + aor present
- `extensions__25-3-hints.conf` — present
- `voicemail__50-3-main.conf` — mailbox `103` present

(Side note, unrelated to this bug: 103's voicemail line has an **empty 3rd comma
field**, i.e. no email address — one of the 58 blind mailboxes in
`AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md`.)

---

## 5. The fix applied

Backup first:

```bash
mysqldump ombutel ombu_devices --where="device_id=171" \
  > /root/ombu_devices_171_backup_20260813.sql
```

Then:

```sql
update ombutel.ombu_devices set mobile_client='no'
 where device_id=171 and tenant_id=3;
```

⛔ **Do NOT fix this through the panel** — setting Mobile Client to "No" and
pressing Update *is* "delete the mobile account", so it very likely hits the same
crash. Go at the DB row.

⛔ **The flag is inert to call handling — proven, not assumed.** The generated
`[T3_103]` pjsip block was diffed against `[T3_301]` (flag `no`): identical apart
from `callerid`. Nothing mobile-specific is rendered from the flag. So **no
regeneration and no reload were needed or done**, and how 103 rings, registers
and takes calls is unchanged. Re-prove this before assuming it of any other
VitalPBX field.

**Rollback:** `mysql ombutel < /root/ombu_devices_171_backup_20260813.sql`, or
simply set the column back to `yes`.

---

## 6. Before anyone deletes ext 103

Checked so nobody has to re-derive it:

- **No route depends on it.** No `ombu_destinations` row has
  `module_id=1, index=130`. Tenant 3's two inbound routes point at destinations
  74 and 344; DID **845-751-8493** goes to `T3_app-time-condition,TC-12`. The
  rendered dialplan is the ground truth here and it was read, not inferred.
- ⛔ **It IS the only member of ring group 822 "Fix Up Group"**
  (`ombu_ring_group_members`: ring_group_id 3 → extension_id 130). Deleting 103
  leaves 822 empty. Nothing currently routes into 822 — a global grep for it
  returns only substring hits inside unrelated phone numbers — so no live call
  path breaks, but the empty group probably wants deleting too.

---

## 7. ⛔ Deleting on the PBX does not stop the billing

Connect keeps its own `Extension` row. It stays `billable`, stays on the invoice,
and stays in the mobile app's Team list (which is where Izzy saw
"Fix Up Group · Ext 103 · Offline"). Same family as the PBX-orphan sweep in
`AGENT_HANDOFF_BILLING_THEME_PBX_ORPHANS_2026-08-12.md`. The Connect record has
to be removed separately.

**Open, flagged to Izzy, NOT investigated:** Connect bills Secro Selutions for
**6** extensions at **$25** each, while the PBX holds **3** (301, 302, 103).
`305 "Fleetease After Hrs"`, `306 "fe forward"` and `307 "NY Gardon Sprinklers"`
exist only in Connect. They may be deliberate; if they are not, that is $75/month
for extensions that are not on the phone system.

---

## 8. Not proven

⏳ **Nobody has pressed Delete since the repair.** The fix is proven as data —
the orphan query is empty and the flag now matches reality — not as a completed
delete. Reload the extensions page and press Delete to close this out.

If it still errors, the fallback is the other direction: insert a stub row into
`ombu_mobile_devices` for device_id 171 so the delete has something real to
remove. That is more invasive (`cloud_id` would be NULL, which may fail
differently against VitalPBX's cloud) and should only be tried if clearing the
flag turns out not to be enough.

---

## 9. Environment notes

- `ombu_extensions` PK is `extension_id`, **not** `id`; `ombu_devices` PK is
  `device_id`. `ombu_ring_groups` has `description`, **not** `name`. There is no
  `ombu_categories` table. Several probe queries died on these first.
- `ombu_destinations` is `(id, category_id, module_id, index)` — `index` is the
  target row's id **within** that module. Module ids: **1** extensions,
  **20** ring_group, **29** inbound_route.
- PBX ssh works straight from the Bash tool here:
  `ssh -i .connect-ssh/connect2_server2_ed25519 -o IdentitiesOnly=yes root@209.145.60.79`
  (port 22, from the repo root). The `pbx` alias pins 2222 and times out.
- ⛔ A repo-wide `grep -rn` from Git Bash on Windows exceeds the 120 s tool
  timeout — use the Grep tool.
