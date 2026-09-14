# ⛔ AGENT HANDOFF — every extension gets FIVE contacts, desk AND WebRTC (2026-08-30, Izzy's standing rule) — READ FIRST before creating a device on any path, before touching `max_contacts`, or before "restoring" the ombu_pjsip_devices default

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(Izzy, 2026-08-30, explicit PBX mandate: *"Every extension that we have gets five
contacts on PJSIP and five contacts on WebRTC… backfill."* Fleet backfill DONE
LIVE on the PBX the same day; code committed on `feat/ivr-migration-takeover`.
Deploy state at the end of this section.)

- ✅ **BACKFILL DONE AND LIVE:** all **156** extension devices now read
  `max_contacts = 5` (was: 30 at 1, 3 at 3, 123 at 5). Applied at 0 active
  calls: `UPDATE ombu_pjsip_devices SET max_contacts=5 WHERE max_contacts IN
  (1,3)` (33 rows) + the same lines patched in the 21 affected
  `pjsip__50-<t>-extensions.conf` files **inode-preserving** (`sed > tmp; cat
  tmp > file` — a bare `sed -i` replaces the inode and strips the panel's
  ACLs, the documented lockout trap) + ONE `module reload res_pjsip.so`. All
  148 live registrations survived. Backups:
  `/root/max-contacts-backfill-20260830T133622Z/` on the PBX.
- ⛔ **RAISE-ONLY: Gesheft T8_101_1 stays at max_contacts 10 ON PURPOSE** —
  she runs 4-5 live windows on that AOR and lowering it would evict them.
  Never "complete" the rule by dropping a deliberate higher value to 5; the
  console guard test pins that an EDIT never re-defaults the field.
- ⛔⛔ **THE TRAP THIS CLOSES: `ombu_pjsip_devices.max_contacts` has a COLUMN
  DEFAULT of 1**, so any creation path that omits the field ships a desk phone
  that can hold ONE registration — which is exactly how every onboarding-built
  desk device sat at 1 (the WebRTC device already got 5 on most paths).
  **FOUR creation paths exist and all four now set 5** (a fix on one of
  several sites is this repo's most repeated defect): onboarding CSV import
  (`pbxTenantBuild.ts` `importExtension`), console create CSV + console
  `deviceOverrides` for NEW pjsip/webrtc devices (`pbxConsoleWrites.ts`), the
  manual-import template (`vitalpbxTemplate.ts` — its webrtc row said **3**),
  and the mirror plan builder (`mirror_writes.py` `desk_max_contacts` default
  1→5, installer embed re-synced, drift guard green). Guarded by
  `apps/api/src/onboarding/maxContactsRule.test.ts` (6 tests, **all five
  source guards fail replayed against pre-change HEAD**).
- ✅ **The PBX's installed helper copy is updated too**: `mirror_writes.py`
  sha matches the repo, py_compile clean, helper restarted (health
  `2026.08.23.1`), **geo path still disabled**. Backup
  `/root/mirror_writes.py.bak-20260830T134220Z`.
- ⏳ **NOT PROVEN: no extension has been created since the change** — the next
  onboarding sign-up (or console create) is the acceptance test: its DESK
  device row must read `max_contacts = 5` in `ombu_pjsip_devices`.
