# ⛔⛔ AGENT HANDOFF — two customers could not receive a voicemail for MONTHS and nobody knew (2026-08-23) — READ FIRST for any "we never get voicemails", before creating an extension by hand in the panel, or before trusting that a mailbox exists

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`31e97d0b` mirror fix + installer re-sync, `00c7f50e` the audit, on
`feat/ivr-migration-takeover`. **Two live PBX writes under Izzy's explicit
mandate**, both verified; no Connect deploy, no migration, no Apply Changes.)

- ⛔⛔ **THE FAULT: `ombu_extensions_vm.enabled` DEFAULTS TO `'no'` IN THE
  VITALPBX SCHEMA.** An extension created without explicitly switching
  voicemail on simply has none — no mailbox in Asterisk, no spool directory,
  and callers cannot leave a message. **Fixup Group ext 103 "Office" (since
  June) and McNamara Lion ext 101 "Juda Poisner" (since April)** were both in
  that state. ✅ Both fixed live; the fleet invariant now balances exactly at
  **124 enabled in the database == 124 mailboxes loaded in Asterisk**.
- ⛔ **THE SIGN-UP WIZARD IS IMMUNE AND HAND-CREATION IS NOT.**
  `pbxTenantBuild.ts` sends `vm_enabled: "yes"` explicitly — added by
  `554c4e86` (2026-05-28, *"explicitly enable voicemail in VitalPBX CSV"*),
  i.e. this exact class was caught once already on the automated path. Every
  casualty was **hand-created in the panel with the box left unticked**;
  none had an onboarding submission.
- ⛔⛔ **WHY NOBODY REPORTED IT, AND THIS IS THE GENERAL LESSON: IT NEVER
  WORKED ONCE, SO THERE WAS NO "IT STOPPED" TO NOTICE.** People report things
  that break, not things that never existed. Connect's voicemail screen shows
  an empty list either way, and Fixup Group has follow-me on that extension,
  so unanswered calls chase another number and the owner very likely gets
  messages on his mobile. **Silence from a customer is not evidence a feature
  works.**
- ⛔⛔ **A MAILBOX LINE WITHOUT ITS `[context]` HEADER LOADS NOTHING — found
  while fixing this, now fixed in `surgical_voicemail`.** A tenant with no
  enabled mailboxes has an **EMPTY generated voicemail file** (header comment
  only, no context), so appending a mailbox line yields a config that looks
  correct, **reloads rc=0, and loads NO mailbox**; `voicemail show users`
  answers *"No such voicemail context"* and nothing is logged at any layer.
  The function now derives the context from the mailbox (the half after `@`)
  and writes the header when absent. ⛔ The installer embeds its own copy —
  **the drift guard caught the divergence**, which is what it is for; re-sync
  it and re-run `install-vitalpbx-inbound-route-helper.test.ts` (55/55).
  ✅ **SHIPPED TO THE PBX 2026-08-23** — `mirror_writes.py` only (the other four
  helper files were verified byte-identical to the repo first, so there was no
  silent downgrade); backup `/root/helper-backup-20260823T211058Z/`, py_compile
  before restart, and the fix **proven against the INSTALLED module** (empty file
  gains the header, existing context not duplicated, old callers unchanged).
  Helper still `2026.08.23.1`, active, geo path still **disabled**.
- ✅ **THE STANDING CHECK: `scripts/pbx/voicemail-mailbox-audit.sh`** (runs on
  the PBX, read-only, exit 1 on a problem). Class A = non-allowlisted
  `enabled='no'`; class B = enabled but absent from Asterisk.
  ⛔⛔ **CLASS A MUST FAIL THE AUDIT AND THAT IS THE WHOLE POINT: pre-fix,
  class B WAS SILENT** — `enabled='yes'` was 122 and Asterisk had loaded 122,
  so the two casualties matched perfectly *by being excluded from both sides*.
  A check that only compared intended-vs-loaded would have watched this for
  four months and reported OK every time. Allowlist via
  `VM_AUDIT_ALLOW_DISABLED` (default `gesheft:898`, the one deliberate
  exclusion).
- ✅✅ **AND IT IS ON A TIMER NOW: `apps/api/src/pbx/voicemailMailboxGuardrail.ts`,
  DEPLOYED (`b9ac1b69`) AND PROVEN RUNNING.** Hourly + a 4-minute boot kick;
  raises an **AgentEscalation** (the only channel that reaches a phone — a guard
  forbids `ADMIN_ALERT` and forbids it growing its own email path).
  ⛔ **De-duped over a 24h WINDOW, deliberately NOT `raiseGuardrailEscalation`** —
  that has no time bound and `AgentEscalationStatus` has no RESOLVED value, so
  each key fires exactly ONCE EVER; this must keep nagging while a customer
  cannot receive voicemail. ⛔ Writes an `AgentAuditLog` row on EVERY run
  including clean ones, with **`actor` AND `hash`** (Prisma rejects the write
  without them — how an earlier monitor went blind while still logging ARMED).
  **Proof it works is the row, never the boot line:**
  `select ts, payload from "AgentAuditLog" where event='voicemail_mailbox.sweep'`
  → first live run `21:28:20 {"alerted":false,"offenders":[],"allowlisted":["gesheft:898"]}`.
  16 tests; typecheck at its 76-error baseline with none in the new files.
  Kill switch `VOICEMAIL_MAILBOX_SWEEP_DISABLED=1`, allowlist
  `VOICEMAIL_MAILBOX_ALLOWLIST`.
- ⛔ **Repairing a mailbox by hand: use the mirror, never Apply Changes.**
  `mirror_writes.py edit-extension --tenant-id N --ext E --vm '{"enabled":"yes"}'`
  (dry-run by default) splices one extension and reloads — **no whole-PBX
  Apply, so no doorway wipe**. It needs `MIRROR_DB_*` env and the venv python
  `/opt/connect-pbx-helper/.venv/bin/python`; MySQL here is **socket-only**
  (`/run/mysqld/mysqld.sock`), and the credentials live in
  `/etc/connect-pbx-helper.env` under `OMBU_MYSQL_*`, not `MIRROR_DB_*`.
- ⛔⛔ **THE MIRROR'S WRITE LEAVES THE FILE UNWRITEABLE BY THE PANEL — fix the
  ACL after every use.** It left `www-data root`, mode 644 and **`mask::r--`**,
  which makes `user:www-data:rw-` **effective:r--** — the documented
  panel-lockout class. Restore from a healthy sibling:
  `chown/chmod --reference` plus `getfacl SRC | setfacl --set-file=- DST`.
  ⛔ Write file contents with `cat new > file`, never `cp`, to keep the inode's
  ownership and ACLs.
- ⛔ **`Playback(disabled)` in a tenant's `VMO<ext>` block is NOT "voicemail is
  off"** — it is the press-0 operator, and it is on **every tenant including
  ones with working voicemail**. It cost a wrong diagnosis; ignore it.
- ⛔ **Testing trap: `${VAR:-default}` treats an EMPTY value as unset**, so
  clearing an allowlist with `VAR=""` silently restores the default and a
  non-vacuity test passes for the wrong reason. Use a non-matching value.
- ⏳ **Open:** **Gesheft 898 "Order Tracking"** is the one remaining disabled
  mailbox — allowlisted as deliberate, worth one confirmation from Izzy. And
  ⏳ **no real caller has yet left a voicemail on either repaired extension** —
  it is proven as far as Asterisk loading the mailbox and the dialplan pointing
  at it; one test call to each closes it.
