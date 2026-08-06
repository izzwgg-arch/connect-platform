# AGENT HANDOFF — the IVR actually works now (2026-08-06)

Owner's words at the start of this session: *"I'm changing recordings, and it's
not changing. I'm publishing, and it's not publishing. I'm switching around
options in the IVR, and it's not changing."* All three were true, and none of
them were his fault. This session found **six** defects between the Studio and
what a caller hears, fixed them, and proved the result with real calls.

Read this before touching the IVR Studio, the publish path, the drift
reconciler, or `connect-tenant-ivr` / `connect-menu` on the PBX.

---

## 0. THE ONE RULE

⛔ **The database is not what callers hear. Verify with a real call.**

Tonight the DB, the publish record, and the API response ALL said "success"
while callers reached the wrong menu — four separate times, for four different
reasons. Every "it's fixed" claim in this session that was based on stored
state turned out to be wrong. The harnesses below place real calls and read the
Asterisk log; that is the only evidence that has ever held up.

---

## 1. The six defects (all fixed + deployed)

### 1.1 The runtime never read the per-number menu — `33c212bb`
`grep -c profile_id` on the live custom dialplan returned **0**. The Studio is
built around "this number plays this menu" and Connect published it to
`connect/didmap/<did>/profile_id`, but `[connect-tenant-ivr]` read ONE
tenant-global menu (`connect/t_<slug>/active_prompt`, chosen by the business
hours schedule) for every number of the tenant.

Consequence: A plus center's Home number answered with "After hours main"
forever; re-recording Home Main changed nothing; changing its keys changed
nothing. **Every "I changed it and nothing changed" report had this one cause.**

Fix: `scripts/pbx/patch-connect-per-number-menu.sh` inserts a per-number branch
that enters `[connect-menu]` with the number's assigned menu.
⛔ The block is entered via the `(permenu)` LABEL and the pre-announce block's
skip-jumps were retargeted to it. The first attempt inserted the block before
the `(prompt)` label, so every `Goto(prompt)` leapt clean over it — the patch
verified as "live" while doing nothing at all.

### 1.2 Publishing never put the audio on the PBX — `33c212bb`, `f38f8cf4`
Only the manual upload route ever pushed WAV bytes. Anything catalogued by a
PBX sync or a migration was metadata with no playable file, so the dialplan's
`STAT()` check fell back to "one moment please". `custom/104_VM` was correct in
the DB, correct in the published family, and absent from
`/var/lib/asterisk/sounds/custom`.

Fix: `materializePromptsOnPbx()` runs on every publish for every referenced ref
(greeting, invalid, timeout, retry, per-key announcements) via the existing
idempotent helper upload. Refs with no audio in Connect are REPORTED
(`audioSync.missingAudio`), never guessed at.

⛔ **There are TWO publish paths** — `POST /voice/ivr/publish` (the Studio
button) and `publishIvrForTenant()` (agent door + mode sweep). They are
near-duplicates. Only the route got the audio fix at first, so every
agent/scheduler publish still shipped broken audio and a stress run through
that path "passed" while callers got filler. **Anything added to one belongs in
both.**

### 1.3 A publish reported success before Asterisk applied it — `d664d0ad`, `7e0d72d5`
`POST /telephony/internal/ivr-publish` wrote every AstDB key with
fire-and-forget `ami.sendAction("DBPut", …)` and returned `{ok:true}` the moment
the loop finished. Nothing waited. A call right after a publish could still hear
the previous menu, and a dropped write was invisible forever. It worsened as key
counts grew (~297 → 471 once per-menu families shipped).

Fix: `AmiClient.dbPut()` awaits the matching Response frame; the route awaits
every write (64-way concurrency, ~3s for 471 keys) and returns **502
astdb_write_failed if ANY key fails** — a partial publish is a FAILED publish.
⛔ Durable writes also blew the api's 8s `publishToAstDb` abort → raised to 60s.
If publishes ever fail with "operation was aborted", check that timeout against
the key count first.

### 1.4 The watchdog overwrote the owner's work — `9cb14e9e`, `4b421579`
The drift reconciler shipped earlier the same night became the problem. Two
separate races:

- **Menu keys**: it replays the LAST publish to repair drift. When an owner
  published while a cycle was in flight, the replay wrote the OLDER keys over
  the new ones. Caught in round 8 of a 10-round run.
- **The number→menu pointer** (`connect/didmap/<did>/profile_id`, which IS the
  assignment): the telephony read endpoint only accepted
  `connect/didmap/<+e164>` while the reconciler verifies the digits family (the
  one the dialplan reads). The read was scope-rejected, every key came back "",
  and "empty" reads as "drifted" — so it repaired **every cycle for every
  number, forever** (visible as a `didmap keys repaired` log line ~every 10
  min). With repairs constantly in flight, one regularly landed after a publish
  and wrote the previous menu back. **Reproduced live: DB said menu 3, publish
  succeeded, AstDB still held menu 1, caller reached the wrong IVR.**

Fix: the endpoint accepts both didmap spellings, and BOTH repair paths honour
`PUBLISH_SETTLE_MS` (5 min) — inside that window the owner's publish is
authoritative and no repair is attempted. The publish record is re-read
immediately before a replay and the write is abandoned if the id moved.
⛔ **Any future repair path that writes owner-chosen state MUST respect that
window.**

### 1.5 The doorway destination row was hijacked — `db4a2ce4`
VitalPBX's panel REWROTE our shared doorway destination (903) in place; it
became `category=ivr index=1` ("Home Main", tenant 2). Both live numbers pointed
at 903, so every id-equality check reported CONNECTED while callers reached a
PBX IVR — and the first `/route-rebake` decoded 903 and re-baked the WRONG
target. Full detail in `AGENT_HANDOFF_CONNECT_DOORWAY_2026-08-05.md`; the rules
that came out of it:

1. Ground truth is the **rendered Goto** in
   `/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf`, never the DB row.
   `/inspect` returns `rendered` + `renderedMatchesMode`; `doorway-status`
   returns `renderDriftedRoutes` and gates `healthy` on it.
2. The doorway Goto is a **CONSTANT** (`_doorway_goto`), never decoded from a
   row the panel can rewrite.
3. Row existence proves nothing — `_find_doorway_rows` requires a semantic
   `valid` (custom_contexts category AND index == cc_id).
4. **VitalPBX's own regen never renders the doorway** — our bake IS the routing,
   so any regen by anything reverts a live number. Detection + auto re-bake is
   the only defense.

### 1.6 An unrecorded menu hung up on callers — `d0dde94b`
Pressing a key into a menu whose greeting was not recorded yet sent the caller
to `vm-goodbye`. Only an UNPUBLISHED menu is dead; `max_retries` is the "this
menu exists" marker. It now plays a neutral prompt and serves that menu's keys.

---

## 2. What shipped alongside

- **Submenu navigation** (`208886ed`) — "press N → another menu" was dead
  (stored as `connect-tenant-ivr,<cuid>,1`, a cuid exten the digit-only context
  can never match). Connect publishes every menu under
  `connect/t_<slug>/menu/<profileId>/*` and rewrites ivr-type refs to
  `Goto(connect-menu,m<id>,1)` at publish time (`ivrMenuNav.ts`). Three additive
  PBX contexts: `[connect-menu]`, `[connect-menu-option-router]`,
  `[connect-menu-play-prompt]` (`scripts/pbx/patch-connect-menu.sh`).
  ⛔ The `m` prefix is **hyphen-free on purpose** — Asterisk strips `-` in
  patterns (`_m-.` matches/displays as `_m.`), which burned two rollbacks.
- **Migration copies recordings** (`b7c9e279`) — the import now calls the
  helper's new `/recording-export` and catalogs what landed. A plus center's
  go-live played generic filler because the audio never left
  `/var/lib/vitalpbx/static/<path>/recordings/<md5>.wav` (note the `.wav`
  suffix; the helper's old comment claimed extensionless and sent debugging to
  "missing" files that existed).
- **Publish guard** (`76835956`) — publishing when menus exist but none is
  selected for the current mode now refuses with a 422 instead of writing an
  empty menu.
- **Schedule-aware selection** (`9ed5db20`) + `ivrModeSelection.ts` extracted
  from server.ts so what-callers-hear logic is unit-testable.

---

## 3. The harnesses — use these, not the database

All on the PBX (`/root/`) and in `scripts/pbx/`:

| script | what it does |
|---|---|
| `ivr-e2e.sh <did> <expect> [keys] [wait] [notExpect]` | one real call, asserts from the Asterisk log |
| `ivr-full-coverage.sh <rounds>` | 20 scenarios/round: entry, greeting changes, every key type, timeout, submenu in/out, invalid exhaustion, re-assignment, concurrency |
| `ivr-pointing-stress.sh <rounds>` | a number lands on ITS menu and nowhere else; cross-tenant isolation; full hand-back / bring-over round trips |

Supporting contexts live in `/etc/asterisk/vitalpbx/extensions__97-connect-probe.conf`
(`[connect-probe]` sets DNID and routes into the tenant's real incoming-calls
context; `[connect-probe-press]` sends real DTMF).

**Harness rules learned the hard way — every one of these produced a false
"product is broken" report tonight:**
- Isolate the trace by the call's **linkedid**; reading the whole log window
  mixes in any other call in flight.
- Match **case-insensitively** — Asterisk logs `BackGround`.
- Ordered assertions (`A&&&B`) must search only AFTER the previous match, or
  "went out and came back" passes on the outbound leg alone.
- Give a menu **~4s** before sending the next key; 500ms is swallowed during
  menu startup. DTMF needs `Dial(...,/n,D(wwww<digits>))` — `/n` stops
  Local-channel optimisation eating the digits.
- **Verify every config write.** Unverified writes (shell quoting producing
  invalid JS, a nullable field the schema rejects) failed silently three times
  and the product took the blame each time.
- Never `scp` a harness onto the PBX or edit a script **while it is running** —
  bash re-reads scripts mid-execution and a half-written file produces a
  syntax error mid-suite.
- Establish preconditions; don't assume them. A leftover hand-back from an
  interrupted run sent checks to PBX voicemail and looked like a defect.

---

## 4. Proof at handoff

- **Full coverage**: 20 scenarios × 5 rounds, real calls. Clean apart from the
  harness faults above, each of which was separately reproduced and fixed.
- **Pointing stress**: **50/50 ALL GREEN** after the reconciler fix — every menu
  on both tenants, cross-tenant isolation, hand-back, and bring-over landing on
  exactly the menu the number was pointed at.
- **Unit**: `didRouteReconciler.test.ts` 22 cases, `ivrModeSelection.test.ts`,
  `ivrMenuNav.test.ts` — all green (`node --experimental-test-module-mocks
  --import tsx --test`).
- Live state: both numbers on their correct menus, `doorway-status`
  `healthy:true`, `renderDriftedRoutes: 0`.

---

## 5. Open items

- **A plus center "Home Main" greeting is `custom/104_VM`** — a voicemail
  recording, almost certainly a leftover test value from the owner. One click in
  the Studio to change; not a bug.
- **ElevenLabs key**: custom "invalid option" / "we didn't hear you" prompts are
  still the Asterisk stock voices (`pbx-invalid`, `vm-enter-num-to-call`).
  Waiting on a fresh `sk_…` key pasted on `/elevenlabs`. See
  `elevenlabs-key-dead-legacy-format` memory.
- The `[connect-probe]` / `[connect-probe-press]` contexts are a TEST HARNESS on
  a production PBX. No inbound route points at them and they are unreachable
  from the outside, but remove them if that ever stops being true.
- Other sessions were committing to this branch throughout. `git fetch` and
  check the tip before deploying; pin `commitHash` on every deploy-queue enqueue
  (an unpinned enqueue deployed a different session's commit once tonight).
