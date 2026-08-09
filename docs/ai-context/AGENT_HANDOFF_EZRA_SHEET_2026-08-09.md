# AGENT HANDOFF — working Ezra's trainer bug sheet (2026-08-09)

Continuation of `AGENT_HANDOFF_TRAINER_AUDIT_2026-08-09.md`. That session audited
the trainer programme and committed `a3fcca41`; this one read the **sheet**, fixed
what it could reproduce, and deployed.

Commits: `d491e364`, `a24f2d54`, `66af2e79` on `feat/ivr-migration-takeover`.
**api + portal DEPLOYED and container-verified. Izzy gave a one-time PBX mandate,
spent on exactly one GRANT.**

---

## 1. The sheet, and how to read it

"Loopcom Edits":
`https://docs.google.com/spreadsheets/d/1Fx27VcEWm3RI6RdYkJgD53lqFLM3zjSdN8sHmYzWAck/edit`

⛔ **Do not scrape the rendered grid.** Fetch
`/gviz/tq?tqx=out:html&sheet=<tab>` and use `get_page_text` — the CSV export gets
truncated by tool output limits and the live canvas glitches when scrolled. The
**"Web app Error"** tab is screenshots; its images do NOT come out of any export,
so open the real sheet and page with the **name box** (Page Down does not scroll it).

⛔ **The sheet is stale in places.** It spans a week when the IVR runtime and the
portal were being fixed daily, and it contradicts itself (row 87 "IVR Studio now
working" vs earlier rows). **Two items were already fixed** by the time I checked.
Re-verify every row live before fixing it.

## 2. THE RULE this session kept proving: reproduce before you fix

Three of the ten "Web app Error" items were not what their label said:

- **"Recording button" / "Per page Button"** is **light theme only**. In dark
  theme those controls are perfect. The generic light-theme
  `select { background: … }` **shorthand** resets `background-size` and
  `background-position` to their initial values; the override that restored the
  look put back only `background-image`, so the two **5px** arrow wedges were
  painted at **full box size** — a slate block with a giant white triangle.
  Measured `background-size: auto, auto, auto` on /calls before the fix.
  ⛔ Geometry must be repeated wherever the image is restored, or the next
  `background:` shorthand strips it again.
- **"Cannot change Profile Picture"** is **data loss, not an upload bug** — see §4.
- **"Cannot Send text"** is **not a bug at all** — see §5.

## 3. ⛔ A message you sent stayed unread to you, forever

"Mark All read button not working both in Android and PC" + "Does not disappear
when clicked". Server-side, which is exactly why both clients failed.

Internal chat messages are stored `direction: "INTERNAL"` — **not `"OUTBOUND"`**
(`connectChatRoutes.ts` ~1594) — so they count toward the unread threshold in
`isThreadSharedNew`. That function also **deliberately excludes the sender** from
the read check. Together: a thread whose newest message *you* sent was New *to
you* permanently. Mark-read wrote `lastReadAt`, the recompute ignored it, and the
item returned on the next poll.

**Proven against production, not reasoned about:** Ezra's own
`"Ezra stress test 1 — Tenant Group Chat"` had been stuck since **2026-07-30**.
`isThreadSharedNew` now takes a `viewerUserId`; a manual mark-unread still wins
(`markTs > newestTs`). Re-run over all **539** threads: **4** viewer-rows change,
every one `viewerIsSender` stuck→cleared, **1018** unchanged.

## 4. ⛔ Every profile photo was destroyed by the next api deploy

The screenshot showed a **broken image**, which is the tell — the upload worked,
the file was gone. Both roots fell back to `<cwd>/data`:

```
USER_AVATAR_STORAGE_DIR    -> /app/data/user-avatars
CONTACT_AVATAR_STORAGE_DIR -> /app/data/contact-avatars
```

Neither env var was set in the running container and **no volume covered
`/app/data`** — `ls /app/data` returned *No such file or directory* while **2
user rows** still carried `avatarStorageKey` AND `avatarUrl`.

This is the **same failure the onboarding uploads had on 2026-08-05** (a
customer's porting bill was lost). Two directories were missed by that fix.
⛔ `docker-compose.app.yml` has **two** api blocks — `api` and `api_candidate`.
Both now carry the env and the mounts (lines 101-102/266-267 and 175-176/309-310);
a volume added to only one tests perfectly then loses everything at the next
blue/green cutover. `warnIfAvatarStorageEphemeral()` now shouts at boot.
The 2 orphaned rows are unrecoverable and will show initials until re-uploaded.

## 5. Two diagnoses that came out the opposite way

- **"Cannot Send text"** — the send-number resolver has had a **final fallback
  since 2026-06-18** that accepts any active, unassigned tenant number, and the
  real Connect Communications tenant has exactly that. The failure was simply
  that **"Ezra stress test 1" (`cms6b72kq16skqt14qgh89m5a`) has ZERO
  TenantSmsNumber rows**. Assign one of the 58 spare inventory numbers per the
  SMS runbook. ⛔ There are **two tenants named "Connect Communications"** —
  `connect-admin-tenant-v1` (no numbers) and `cmqzfigij4bt0mw13u2ulpd0t` (the
  real one). That tripped the first pass.
- **"Opacity of Search bar letters"** — already fixed. The Team Directory
  placeholder measures **17.85:1**. Left alone. (Route is `/team`, not
  `/team-directory`.)

## 6. ⛔ NOT REPRODUCED: closed hours and holiday

Five sheet rows say "Closed hours not working" / "Holiday not working". **The
mode sweep works.** `sweepIvrModeBoundaries()` republishes at schedule
boundaries; all 3 tenants with a schedule are `isActive`, all have publish
records, and Connect Communications was sitting in `afterhours` mode when checked.

Two live oddities remain, **neither concluded**:
1. Connect Communications has **a holiday DATE set but no holiday MENU**
   (`holidayProfileId` null). `ivrFindActiveProfile` then falls back
   holiday → afterHours → default, so a holiday silently plays the after-hours
   menu. That reads exactly as "Holiday not working".
2. **Ezra's test tenant has no schedule row at all**, so `computeCurrentMode`
   returns `"business"` forever and closed hours could never fire for him.

⛔ Per the IVR runtime handoff: the database is not what callers hear. Do not
call this fixed without a real test call.

## 7. Timeout and retries were never broken server-side

"IVR Set up for 7 seconds, cannot be changed" and "No way to edit" were a
**missing control only**. The API has always accepted `timeoutSeconds` (1-60) and
`maxRetries` (1-10) on `PATCH /voice/ivr/route-profiles/:id`, both sit in
`PROMPT_FIELDS` so prompt-edit rights suffice, and publish already writes
`timeout_seconds` / `max_retries` into the tenant AstDB family. `66af2e79` adds
the two pickers using the existing `Step actions` pattern.

## 8. The hold-music grant — the one PBX write

Every "Secro" and every revert-to-schedule failed with
`native_tenant_moh_sync_failed`. Verified independently before touching it:
`connect_route_helper` had `UPDATE (music_group_id)` on `ombu_queues`,
`ombu_inbound_routes` and `ombu_extensions` — and **SELECT only** on
`ombu_ring_groups`. Applied:

```sql
GRANT SELECT, UPDATE (`music_group_id`) ON `ombutel`.`ombu_ring_groups`
  TO 'connect_route_helper'@'localhost';
```

Confirmed after: `GRANT SELECT, UPDATE (music_group_id) ON ombutel.ombu_ring_groups`.
Backup of the prior grants: `/root/moh-grant-backup-20260809-164222/`.
⏳ **Not yet proven end to end** — nobody has asked the assistant for "Secro"
since. Do that; it is the acceptance test.

## 9. Deploy notes

- api `a24f2d54` (387s) and portal `66af2e79` (411s) via the deploy queue.
  Enqueue is **`POST /ops/deploy/enqueue`** with `{service, branch, requestedBy}` —
  *not* `/ops/deploy/jobs`, which only reads. Pass **branch, never a pinned
  commit**, so the tip at run time wins.
- ⛔ **`pgrep -f run-heavy` in an ssh one-liner matches its own command line** and
  reported a heavy job that did not exist. Use `pgrep -af "run-[h]eavy"`.
- The agent is still a manual `docker compose -f docker-compose.app.yml -f
  docker-compose.agent.yml up -d --build agent`. It has **no `depends_on`**, so
  it cannot disturb the api. Launch it with `setsid nohup … < /dev/null & disown`
  and poll the log — a plain `&` dies with the ssh session.
- Verified in the running containers, not from the commits: avatar env + mounts +
  dirs, the chat comment in api source, and in the portal `.next` build the
  `1250` z-index, `padding-right:72px`, `background-size:5px 5px,…`, and the
  IVR "How long to wait" label. Then re-verified three of them in a real browser.

## 10. Open

1. **Tell Ezra the lesson feature works**, with the phrasings that fire it. He
   has believed for 13 days that the agent cannot learn and stopped trying.
2. **Answer his four escalations** (oldest 2026-08-04) and the extensions he
   asked for twice (1102 Sales, 1103 Service). Nobody owns that queue.
3. **Assign an SMS number** to "Ezra stress test 1" (§5).
4. **Closed hours / holiday** (§6) — needs a real call.
5. **IVR Studio Round 3 was never run** — 10 scenarios, all blank.
6. Prove the hold-music fix by asking the assistant for "Secro" (§8).
