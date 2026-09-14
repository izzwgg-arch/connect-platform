# ⛔⛔ AGENT HANDOFF — the PBX Console draws the panel's WHOLE form now (289 fields, nothing hardcoded), and the licence proof found that EXTENSIONS are the one module the free panel refuses (2026-08-21) — READ FIRST before adding a field to any console screen, before believing "extension edit works unlicensed", or before trusting a panel save that timed out

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PBX_CONSOLE_WHOLE_PANEL_FORM_2026-08-21.md`**
(`e5ea8692` + `39902d81` on `feat/ivr-migration-takeover`. **No PBX write on
production** — every write went to the unlicensed clone; live-panel form reads
are GETs. Deploy state in §7 of the handoff — ⛔ verify the containers, the
pipeline was failing when this was written, see the last bullet.)
Izzy: *"every single option that exists in the PBX right now… should be in the
Connect UI, same layout as the PBX, just with Connect theme"*, then *"every
single field, option, toggle, and button should be wired end to end, working
with proof outside the license."*

- ⛔⛔ **THE RULE: the console must not contain a field list.** It renders whatever
  the panel renders — the panel's tabs, section headings, labels, hover help,
  required markers, control types and **complete** option lists, in the panel's
  own order. **289 fields, 1,411 options, 7 row tables, 26 section headings, 19
  tabs, 7 modules.** A VitalPBX upgrade that adds or renames a field shows up in
  Connect the same day. ⛔ **The moment somebody types a panel field name into
  `panelSchema.ts` or the portal, the two can drift — silently, because a missing
  field looks exactly like a field that never existed.** Same discipline
  `conferenceBuilder` already uses.
- **Where:** `pbxConsole/panelSchema.ts` (form → what to SHOW),
  `panelFormWrite.ts` (edits → what to POST, pure), routes
  `GET|POST /admin/pbx-console/panel/:module/{form,save}` (both `requireOwner`),
  portal `PanelForm.tsx`. Every module's Edit and New open it.
  ⛔ **The GET deliberately does NOT use `withPanel`** — that ends in
  `applyAndRebake`, a whole-PBX Apply; merely OPENING a form would regenerate
  every tenant with pending changes and re-bake the doorway.
- ⛔ **The panel class names are not the screen names, and two mislead:** an
  outbound route is **`trunk_group`**, route selection is **`ars`**.
- ⛔⛔ **PROVEN OUTSIDE THE LICENCE on the Community-edition clone (`vpbx-clone`,
  `/var/lib/pbx-licenses` empty), driving the SHIPPED code, read → write → read
  back → restore: tenants, trunks, outbound routes, route selections, ring groups
  and QUEUES all pass.** Queues had never been tested unlicensed before (§11 of
  the licence-exit assessment lists it under "NOT tested"). Harness:
  `scripts/pbx/mirror/unlicensed-console-proof.ts` (refuses to run against a live
  host).
- ⛔⛔ **AND IT CORRECTS A RECORDED FACT: EXTENSIONS DO NOT.** The licence-exit
  assessment says *"extension create/edit/delete ✅ works unlicensed"*. Over the
  free tier's 12-extension cap the panel refuses an extension SAVE **both ways
  round**: carry the rendered device fields and it answers *"You've reached the
  maximum number of allowed extensions"* (it reads the save as a device ADD);
  drop them and its own validator crashes with **`Undefined array key "user" at
  modules/extensions/Validations.php`**. There is no third shape —
  `pbxConsoleWrites.ts` already documents that the save ALWAYS carries a device
  sub-form. What the assessment actually proved was `addExtensionToTenant`, which
  **creates** via CSV import, and one device *add* — different controllers.
  ⛔ **So editing an extension is the ONE console operation that stops working the
  day the licence lapses.** `mirror_writes.py` has `add_extension` and **no edit
  writer**; that is the gap to close. The cap now surfaces as a plain-English 409
  instead of a 500 that reads like Connect broke.
- ⛔ **The extension save's one accepted shape:** the generic route hands
  extensions to `saveExtension`, which posts general fields plus each device's
  fields from **that device's own form** (`method=getDevice`) with the dtmf from
  the database. Never re-post the RENDERED device fields — this repo already
  records that flipping a desk phone from rfc4733 to rfc2833.
- ⛔⛔ **A PANEL SAVE THAT TIMES OUT HAS STILL LANDED.** The first proof run
  reported `FAIL tenants: aborted due to timeout` (the 30 s cap in
  `panelClient.ts:107`) — **the write had gone through**, so the restore never ran
  and the clone kept a polluted description until it was put back by hand. Same
  lesson as the VoIP.ms rotation: a timeout is "I stopped listening", never "it
  did not happen". Any retry must re-read before re-writing.
- ⛔ **Four parser traps, each now a test** (synthetic fixture — the real forms
  carry 69 customers' names and a live CSRF token): scanning controls must be an
  **alternation**, never an optional group (greedy swallows fields to the next
  `</select>`; lazy `??` returns zero options — both hit for real); a `form-group`
  block runs to the NEXT one so the control belongs to a label only if it is the
  **first** in the block; bare controls under **`<div class="legend">`** (not a
  `<legend>` tag) have no wrapper and are the destination of every ring group and
  queue; and a **radio button-group is a real field** — skipping radios dropped
  `technology` (PJSIP/IAX2/VIRTUAL/TENANT) from both the extension and trunk forms.
- ⛔ **`/etc/connect-robot/credentials.env` CANNOT BE `source`d** — the robot
  password contains `(`, `*`, `#`, `>` and `;`, so the shell dies **and prints the
  password**. Read it with a parser. ⏳ **It leaked into a session transcript that
  way on 2026-08-21; rotating the robot panel password was already an open TODO
  and is now overdue.**
- ⛔ **Do not scp into `/opt/connectcomms/app`** — an untracked file blocks the
  next deploy's `git checkout -B`. The proof harness runs from
  `/root/console-proof/`; `panelClient.ts` has **no imports at all**, so it needs
  5 files and no packages.
- ⛔⛔ **DEPLOYS WERE FAILING PLATFORM-WIDE while this shipped, and it is NOT a
  code fault: nginx listens on `45.14.194.179:443`, NOT on loopback**, while the
  deploy queue sets `DEPLOY_{API,PORTAL}_PUBLIC_VERIFY_RESOLVE_LOCAL=1`, which
  curls `--resolve host:443:127.0.0.1`. That can never connect, so every rollout
  dies at "public verify probe failed … http_code=000" and correctly rolls back.
  **The platform is healthy throughout** — resolving to the public IP answers
  **200**. Three separate jobs (two api, one portal, on three different commits)
  died this way. ⛔ **`http_code=000` is a CONNECTION failure, not a bad status —
  never read it as "the app is down"; check the public IP before believing an
  outage.** Workaround for a single run:
  `DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=0`.
  ✅ **RESOLVED 2026-08-21 — BOTH halves are in place; see the dedicated section at
  the top of this file.** The script now PREFERS loopback and FALLS BACK to ordinary
  DNS (`9af55418`), and a parallel session gave nginx a `127.0.0.1:443` listener.
  ⛔ The paragraph above is OUTAGE HISTORY, not the live state — re-verify before
  acting on it.
- ⛔⛔ **STRESS-TESTED OUTSIDE THE LICENCE, EVERY FIELD (2026-08-21, handoff §8):
  157 field-saves PASS on the unlicensed clone** — each one mutate → save →
  re-read from the panel → verify → restore → verify — plus every row table
  (mutate a cell, add a DISTINCT row, remove it), CREATE→verify-in-MySQL→DELETE
  for trunk/route/ars/ring group/queue, and a queue timing change grepped out of
  the RENDERED Asterisk file after Apply. 7 refusals are the panel's own
  validation speaking through our path; 35 skips are documented (identity
  fields, passwords, DB-proven panel-managed fields). Harnesses:
  `scripts/pbx/mirror/stress-console-fields.ts` + `stress-retest-fails.ts`.
- ⛔⛔ **THE STRESS RUN CAUGHT THREE REAL ROW BUGS, all fixed (`b10151fd`):**
  (1) **hidden per-row pairs must travel with their row** —
  `queue_members[N][member_id]` is how the panel tells update from add;
  rebuilding rows from visible cells alone made queues.php throw, and a NEW row
  must NOT carry an id (the builder fills `member_id=""` from the template);
  (2) **the placeholder row is part of the post** — a browser submits the
  literal `{{row-count-placeholder}}` template row and the save controller
  requires the array key (queue create dies on `Undefined array key
  "queue_members"` without it; teamBuilder always posted it);
  (3) underscore-shaped concrete row cells (`queue_members_0_extension_id`)
  leaked into the field list and drew every member row twice.
- ⛔ **DB-PROVEN PANEL SEMANTICS — never "fix" these:** ~14 trunk fields
  (`tenant_trunk_id`, `outgoing_settings`/`incoming_settings`, the
  `outgoing[…]`/`incoming[…]` type/trunk/qualify/insecure family) are IGNORED by
  the save controller for a PJSIP registration trunk — save accepted, ombu row
  byte-identical; their live state is JS-rendered and invisible in raw HTML.
  `hangup_dest_custom` persists only when the destination IS custom. A queue
  CREATE requires ≥1 member ("No agents assigned" — the panel's own rule).
- ⛔ **OPEN, small, DB-proven:** trunk **Custom Parameters rows do not persist**
  through a generic re-post and Custom Headers show a form-vs-DB disagreement —
  the panel's JS does something extra on those two tables; no Connect writer has
  ever used them. Close it by capturing a real browser session of a panel-side
  Custom Parameter add.
- ✅✅ **THE ONE BUILD LEFT IS BUILT AND CLONE-PROVEN (2026-08-22, handoff §8.8):
  the mirror EXTENSION EDIT-WRITER exists** — `edit_extension` +
  `apply_extension_edit_pbx` in `mirror_writes.py` (whitelisted-column row
  UPDATEs; SURGICAL per-extension splice of the pjsip triples + voicemail line
  via block functions factored out of the byte-identical renderer, tmp+
  `os.replace`; bounded AstDB refresh that ⛔ NEVER writes `dial` — wake-dial
  owns that key), helper **`2026.08.22.1`** `POST /mirror/extension-edit`, and
  `saveExtensionOrMirror` in the console falling back **only on the cap
  refusal** — panel first, always; unsupported fields refused BY NAME, never
  dropped. Clone acceptance: edit live in Asterisk, only the edited
  extension's blocks moved, revert **sha256-identical**
  (`scripts/pbx/mirror/edit-extension-accept.py`).
  ✅✅ **HELPER `2026.08.22.1` IS INSTALLED ON THE PBX AND PROBED LIVE
  (2026-08-23, Izzy's in-chat permission)** — files backed up to
  `/root/helper-backup-20260823T033832Z/` first; health reads `2026.08.22.1`;
  all four column-scoped UPDATE grants landed; the geo path unit **stayed
  disabled** (the installer's new preserve-disarm branch worked); all three
  service drop-ins intact; `/mirror/extension-edit` answers its own
  validation refusals (bad ext / unknown field / empty edit) with nothing
  written. ⛔ **The trap that broke the first install run: the installer's
  grant SQL rides an UNQUOTED heredoc** (it interpolates `${MYSQL_PASS}`), so
  a bare backtick in SQL (`` `lock` ``, `` `delete` ``) is bash command
  substitution — `lock: command not found` and a mangled GRANT that aborted
  the `set -e` installer mid-way (helper files landed, service not restarted).
  **Escape backticks as `` \` `` in that heredoc**; guard-tested. ⛔ The
  helper's auth header is **`x-connect-pbx-helper-secret`** — a probe with
  any other header name reads as 401 and looks like a broken secret.
  ⛔ **The ROBOT IS NOT RETIRED BY THE LICENCE EXIT — asked and answered
  (Izzy, 2026-08-23).** The console's writes deliberately REPLAY THE PANEL
  through the robot for everything the free edition still allows; the mirror
  covers only what it refuses (tenant create, extension edit/add over the cap,
  provisioning, geo). Dismantling the robot = re-implementing every panel
  write + renderer, the 6–10-week route the mirror design was chosen to avoid.
  ⛔⛔ **THE CAP CORRECTION (2026-08-23, boundary-proven on the clone — console
  handoff §8.9): the free tier's 12-extension cap is PER TENANT, not PBX-wide,
  and AT the cap the CSV import answers "Import Completed Successfully" while
  creating NOTHING** — no row, no error, anywhere. Under-cap tenants create
  AND edit unlicensed through the panel (re-proven); over-cap tenants (prod
  today: A Plus Center 21, Gesheft 18) need the mirror for both — and both
  exist now: helper **`2026.08.23.1`** adds `/mirror/extension-add` (standard
  desk+app shape, `_MIRROR_APPLY_LOCK` serialising both appliers against the
  read-patch-replace race), and the console's create falls back on the
  DETECTED silent no-op (`extension-import-capped`) only when the tenant
  really holds ≥12. Panel DELETE + regen work over the cap (proven).
  ⛔ **Never trust that importer's success note — only the extension EXISTING
  is proof.**
  ✅✅ **STRESS-TESTED (Izzy's order): 62 checks, 0 failures** — 20 edit→revert
  cycles across 6 clone tenants with per-cycle sha256 byte-restore, 15 hostile
  config-injection inputs all refused with zero bytes written
  (`validate_extension_fields` — commas/`;`/`"`/`|`/control chars are
  STRUCTURAL in Asterisk configs; whitelist calibrated against a live-fleet
  census so no real name refuses). The run caught **three pre-existing
  renderer byte-bugs**, all fixed: pjsip option ORDER (codecs after
  parkinglot, named pickup groups after mailboxes — invisible on the original
  fixture tenants), voicemail `tz=` belongs FIRST, and `tz.get("name")` read a
  nonexistent column and wrote literal `tz=None`. t2's live pjsip + voicemail
  files now byte-equal the fixed renderer.
  ✅✅ **THE ROBOT PANEL PASSWORD IS ROTATED (2026-08-23, Izzy's order) — the
  twice-leaked password is DEAD** (verified refused at the prod panel).
  Mechanism: through the panel's own users form
  (`scripts/pbx/rotate-robot-panel-password.ts` — ⛔ `ombu_users.password` is
  binary(64), NOT bcrypt/sha512; never write the hash directly), rehearsed on
  the clone first. New password is alnum-only ON PURPOSE (the old one's
  `(*#>;` are why credentials.env could never be `source`d — that trap is
  dead too) and lives ONLY in root-only files
  (`/root/robot-panel-password-new-20260823.txt`, backups
  `/root/credentials.env.bak-20260823T0640Z` on loopcom +
  `/root/robot-row-backup-20260823.sql` on the PBX) — it never entered a
  transcript. The clone's robot row was rotated to match. ⛔ The api reads
  these creds from ENV at container CREATE — the rotation is complete only
  once the api is recreated (rides this pass's deploy).
  ⛔ **Cancelling still waits on**: one real phone registering + calling on
  a mirror tenant (Loopcom Demo 2 is built and waiting), and the prod negative
  test (Extensions → Edit still saves via the panel, `viaMirror: false`).
- ⏳ **NOT PROVEN: nobody has opened the new form in a browser and no write has
  been made from it against PRODUCTION.** Proven as 50 tests, portal typecheck 0,
  api typecheck at its exact 75 baseline, and 6 of 7 modules written and read back
  unlicensed. **Acceptance: Trunks → Edit on Loopcom Demo 2, change the
  description, save, reopen** — then the negative that matters, **Extensions →
  Edit still saves on production** (the licence is live, so the cap does not fire).
  ⏳ File uploads (outbound-route CSV, extension photo) are deliberately not wired
  and say so; creating an extension from the generic form is refused on purpose.
  Mockup, generated by the SAME parser the api runs:
  <https://claude.ai/code/artifact/66bb5c11-700c-43b7-a4b2-d2d36404fff3>
