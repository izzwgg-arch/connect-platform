# ⛔ AGENT HANDOFF — A plus center "not all users synced": the 21 extensions ARE in sync and VitalPBX holds NO emails, so there are no users to import (2026-09-08) — READ FIRST before "re-syncing" a tenant's users, or before adding emails on the PBX to make the sync create accounts

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_APLUS_USER_SYNC_2026-09-08.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**)
Izzy: *"A+ Center in Loopcom doesn't have all users synced. Please get all users from A+ Center, all extensions synced with Loopcom."*

- ✅ **Extensions: VitalPBX tenant 2 returns 21, Loopcom holds the same 21** (all ACTIVE,
  all with a SIP password). The 5-minute auto-sync logs `125/125` upserted, 0 deactivated.
  Proven by a read-only `listExtensions("2")` run inside `app-api-1` against the live PBX.
- ⛔ **Users: the sync makes a user ONLY from the PBX extension email (`pbxExtensionSync.ts`
  §4c), and every one of the 21 A plus extensions has an EMPTY email on the PBX.** The 6
  existing users (101–105, 110) were created by hand. The 15 unowned extensions are Moms
  Phone, voicemail, Home, Tottys Cell, AIT Room, Mrs. Glick, Room 1–6, Inside/Front Door,
  leah cell — mostly not people. ⏳ **Blocked on Izzy: which of those are people, and what
  email each uses.** Then create them through `POST /admin/users` (invite mail, extension
  assignment) — never with invented addresses, never by writing emails into VitalPBX.
- ⛔ The old checkout `C:\dev\projects\connect2` is on `feature/loopcom-rebrand` (stale since
  08-24); this branch lives at `C:\dev\projects\connect2-takeover` (worktree). The old tree's
  root ACL blocks file creation and a checkout there DELETED its `AGENTS.md` from disk —
  recovery in the handoff §5.
