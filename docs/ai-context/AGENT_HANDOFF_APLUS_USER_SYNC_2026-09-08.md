# AGENT HANDOFF — A plus center "not all users synced": extensions ARE in sync, and VitalPBX holds NO emails to make users from (2026-09-08)

**Read-only investigation. No code change, no deploy, no PBX write, no data change.**
Izzy, 2026-09-08: *"A+ Center in Loopcom doesn't have all users synced. Please get all
users from A+ Center, all extensions synced with Loopcom."*

## 1. What was checked

| Source | How | Result |
|---|---|---|
| Loopcom DB (`connectcomms-postgres`) | `psql` over `ssh connect`, tenant `cmnlgnumi0000p9g6l7t1t0z7` "A plus center", link `pbxTenantId=2`, code `T2`, `LINKED` | **21 extensions**, all `ACTIVE`, all with `PbxExtensionLink` + SIP password; **6 users** |
| VitalPBX tenant 2 | read-only `client.listExtensions("2")` run inside `app-api-1` (`scripts/aplus-pbx-probe.ts`, deleted after) | **21 extensions** — the same 21 numbers |
| Auto-sync | `app-api-1` log `pbx_auto_sync_complete` every 5 min | `extensionsFound 125 / upserted 125 / deactivated 0` — the sync is healthy |

**Extensions: 21 = 21. Nothing is missing on either side.**

## 2. Why users are "missing"

`syncExtensionsFromPbx` (`apps/api/src/pbxExtensionSync.ts` §4c) creates a Loopcom user
**only when the PBX extension carries an email** (`email` / `email_addresses`). On VitalPBX
tenant 2 **every one of the 21 extensions has an empty email** — `Extension.pbxUserEmail` is
NULL for all 21 in Loopcom for that reason, including the 6 that already have owners
(those users were created by hand on 2026-04-06 and 2026-06-28).

So there is no user data in VitalPBX to "get". The gap is an input gap, not a sync fault.

## 3. The 21 extensions and who owns them

| Ext | PBX name | Loopcom owner | Devices on PBX |
|---|---|---|---|
| 101 | Leah Fulop | leahw@apluscenterinc.org | 101 (desk) + 101_1 (WebRTC) |
| 102 | Mrs Weinstock | yehuditw@apluscenterinc.org | 102 |
| 103 | Jacob Weinstock | jacobw@apluscenterinc.org | 103 + 103_1 |
| 104 | Libby Weinstock | saraw@apluscenterinc.org | 104 |
| 105 | Mrs Brach | sarahb@apluscenterinc.org | 105 + 105_1 (+ one empty device row) |
| 110 | TEMP | izzywkg@gmail.com | 110_1 |
| 106 | Moms Phone | **none** | one empty device row (`user` null) |
| 107 | voicemail | **none** | 107 |
| 108 | Home | **none** | 108 + 108_1 (WebRTC) |
| 109 | Tottys Cell | **none** | one empty device row |
| 111 | AIT Room | **none** | 111 |
| 112 | Mrs. Glick | **none** | 112 |
| 502–507 | Room 1–6 | **none** | desk device each |
| 509 / 510 | Inside Door / Front Door | **none** | desk device each |
| 511 | leah cell | **none** | one empty device row |

## 4. What it takes to finish

A Loopcom user needs a **unique email + first + last name** (`POST /admin/users`,
`server.ts:6804`; it also assigns the extension and sends the `USER_INVITE` mail when
`sendInvite` is true). ⛔ Do not invent emails. Izzy has to say, per extension, which of
the 15 unowned ones are **people who should log in** and what address each uses. Rooms,
doors, "voicemail" and cell forwards are probably not users at all.

⛔ **Do not add emails on the VitalPBX side to "make the sync do it"** — that is a PBX
config write (`AGENTS.md` absolute rule), and the sync would then create accounts with
random passwords and no invite email anyway.

## 5. Side observations (not acted on)

- Extensions 106, 109, 511 (and a spare row on 105) return a device with `user: null`
  on the PBX — empty device rows. The sync falls back to the bare extension number as
  `pbxSipUsername`, which is what the DB shows. Harmless for this question.
- The stale local checkout `C:\dev\projects\connect2` sits on `feature/loopcom-rebrand`
  (8 commits not on this branch, last 2026-08-24). This branch is checked out at
  `C:\dev\projects\connect2-takeover` (git worktree) because the root folder ACL of the
  old tree blocks file creation — a `git checkout` there deleted `AGENTS.md` from the
  working tree and could not recreate it. Restore with an elevated
  `icacls C:\dev\projects\connect2 /grant ezra:(OI)(CI)M` then `git checkout -- AGENTS.md`.
