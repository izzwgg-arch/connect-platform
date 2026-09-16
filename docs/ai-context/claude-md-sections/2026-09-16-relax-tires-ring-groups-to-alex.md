# ⛔ REVERTED SAME DAY (2026-09-16, later): both ring groups are back on 101 — the Alex move below is UNDONE

Izzy: *"Put Relax Tires phone calls back to the way it was this morning, away from
Alex, back to 101."*

Exact inverse through the same door, `PATCH /admin/pbx-console/ring-groups/:id`
body `{rgMembers:[154], set:{destination:"154"}}` for RG 89 and RG 90 (154 = ext
101 S M Weiss, re-checked in `ombu_extensions` first). Both 200,
`applied:true, rebaked 4/4, failed 0`.

✅ Verified on the PBX after the write: `ombu_ring_group_members` 89→154, 90→154;
`dialplan show 800|801@T25_ext-ringgroups` (IN MEMORY) both
`Dial(Local/101@…)` + `Goto(sub-extensions-vm,VM-101,1)`. 102 appears in
neither. The five IVR vm_direct pointers were never moved, so they already
match this morning (101's box). **T25 routing now equals the morning state.**
⏳ No real call placed.

⛔ **Trap hit:** another session's blue/green api deploy swapped `app-api-1`
mid-script — RG 89 applied, then the `docker exec` died with exit **137**
before RG 90 ran (a half-applied state: 800→101, 801→102). Re-read the PBX,
waited for the new container to be healthy, re-ran RG 90 alone. **After any
exit 137 from `docker exec app-api-1`, read the PBX state per object — never
assume all-or-nothing, and never blindly re-run the whole batch.**

Alex (102) still exists with his own extension, devices and billing — only the
ring-group routing was reverted.

---

# Relax Tires: both ring groups moved off 101 → Alex (102), and the IVR-level voicemail drops still point at 101 because NO DOOR EXISTS to change them (2026-09-16)

Izzy: *"Make all ring groups on relaxed tires. Remove 101 from it and put Alex in
instead. All ring groups and all menu options should go to Alex. Everything
that's going to 101 right now should go to Alex. Through the ring groups."*

Tenant **Relax Tires** `cmnlgryme000up9paz1w40fg0`, PBX tenant **25**
(path `fcab1cd3482527c3`). Alex Silva = ext **102**, PBX `extension_id` **669**
(created 2026-09-16, see `2026-09-16-relax-tires-two-new-extensions.md`).
101 = S M Weiss, `extension_id` 154.

## The whole call flow, mapped first (read this before touching T25 routing)

DID **845-776-1765** → inbound route 86 → time condition 16 "Main"
(business hours → IVR **43 "Main"**, after hours → IVR **44 "After Hours"**).

- IVR 43 keys: **1 → RG 800 "New Tires" (id 89)**, 2 → announcement "Hours"
  (returns to menu), **3 → RG 801 "Warranty Claim" (id 90)**, 4 → announcement
  "Location" (returns to menu). The ring groups are the ONLY paths to a person.
- IVR 44 has NO digit keys — one hidden code **1159** → vm_direct, plus
  invalid/timeout exits. After-hours callers time out into a mailbox.
- Both RGs: strategy ringall, ringtime 30, no-answer → vm_direct.

## ✅ DONE and verified on the running Asterisk (not just a 200)

Both writes went through the deployed console door
`PATCH /admin/pbx-console/ring-groups/:id` (SUPER_ADMIN token hand-rolled
inside `app-api-1` against `127.0.0.1:3001` — same recipe as the October
projection handoff), body `{rgMembers:[669], set:{destination:"669"}}`:

- **RG 89 + RG 90 member: 154 → 669** (`list[]` replaced).
- **RG 89 + RG 90 no-answer voicemail: 101's box → 102's box** (`mod_dest`
  stays 25 = vm_direct; `destination` 154 → 669).
- Both answered `{applied:true, rebake:{attempted:4, rebaked:4, failed:0}}`.

Proof beyond the 200, on the PBX itself: `ombu_ring_group_members` now 669 for
both; dests 584/585 now `vm_direct 669`; the RENDERED
`extensions__50-25-dialplan.conf` `[T25_ext-ringgroups]` blocks for 800/801
both carry `Dial(Local/102@T25_ring-group-dial/n,30,…)` and
`Goto(sub-extensions-vm,VM-102,1)`; and `asterisk -rx "dialplan show
800@T25_ext-ringgroups"` (and 801) shows the IN-MEMORY dialplan dialing 102 →
VM-102. 101 appears in neither block.

⏳ **NOT PROVEN: no real call was placed.** Acceptance is a live call to
845-776-1765 pressing 1 (or 3) that rings Alex's desk/app and, unanswered,
lands in HIS mailbox. Alex's endpoints were live at write time (`T25_102`,
`T25_102_1` registered per the extensions handoff).

## ⛔ THE FINDING — five vm_direct pointers at 101 remain, and NO sanctioned door can move them

Still pointing at **101's voicemail** (dest rows in parentheses):

| where | what |
|---|---|
| IVR 43 invalid (586) + timeout (587) | Main-menu caller who presses nothing/junk drops into 101's box |
| IVR 44 invalid (594) + timeout (595) | EVERY after-hours voicemail lands in 101's box |
| IVR 44 hidden code 1159 (596) | direct-to-mailbox code → 101's box |

Why they were left: **there is no door.**
- The console's generic panel form (`/admin/pbx-console/panel/:module`) has NO
  `ivr` module in `PANEL_MODULES` (panelFormWrite.ts).
- The helper's `/ivr-action` `native_set_entry` targets only
  extension/queue/ring_group/ivr/time_condition/custom_application — **no
  voicemail target** — and its option regex caps at 2 digits, so code `1159`
  is unaddressable anyway. There is no native-IVR action for invalid/timeout
  exits at all (`set_exit` is Connect-profile-only).
- Hand-SQL on the PBX is the hard guardrail this file's worked example exists
  for. Not done.

**Izzy must choose the target before anyone builds the door:** Alex's
voicemail (the literal "everything going to 101 goes to Alex"), or ring the
group first ("through the ring groups" — but an exit can't point at a RG with
today's doors either). Cheapest build: add `ivrs: {cls:"ivr", scope:"tenant"}`
to `PANEL_MODULES` — the generic form write was built for exactly this — but
the IVR form's entry repeat-rows are untested under a full re-post; rehearse
on the clone first ([[rehearse-pbx-writes-on-the-clone]]).

## Traps hit / avoided

- The RG edit form's no-answer destination is `mod_dest` (category id, 25 =
  vm_direct) + `destination` (the extension_id, NOT the extension number).
  `applyOverrides` posts any named field without option validation — the panel
  validates server-side.
- Ring groups are native VitalPBX config — the Connect drift reconciler does
  NOT touch them, so this edit cannot be reverted the way the 2026-09-11
  inbound-route hand-edit was. The console PATCH applies + re-bakes itself.
- `dialplan show 800@…` needs the real context name `T25_ext-ringgroups`
  (read it off the rendered conf), not `T25_ring-groups`.
