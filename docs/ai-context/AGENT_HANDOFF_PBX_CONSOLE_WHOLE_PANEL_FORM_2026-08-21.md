# ⛔⛔ AGENT HANDOFF — the PBX Console draws the panel's WHOLE form now (289 fields), and the licence proof found that EXTENSIONS are the one module the free panel refuses (2026-08-21)

**Commits:** `e5ea8692` (the form) + `39902d81` (the licence proof + the extension
finding), on `feat/ivr-migration-takeover`.
**Deploy state:** see §7.
**PBX writes:** none on production. Every write in this engagement went to the
**unlicensed clone** (`vpbx-clone`). Reads of the live panel's forms were GETs.

Izzy, 2026-08-21, after rejecting a hand-picked field list twice:

> *"Every single option that exists in the PBX right now, in extensions, tenants,
> outbound routes, ring groups, and queues, should be in the Connect UI, same
> layout as the PBX, just with Connect theme."*
> *"Now make it look exactly 100% like the mockups on the dot, and every single
> field, option, toggle, and button should be wired end to end, working with
> proof outside the license."*

---

## 1. ⛔ THE RULE THIS EARNED: the console must not contain a field list

The console used to show a short list of fields somebody had chosen — that is
what got rejected, twice, and rightly. It now renders **whatever the panel
renders**: the panel's tabs, its section headings, its labels, its hover help,
its required markers, its control types and its **complete** option lists, in the
panel's own order.

**Nothing in Connect names a panel field any more.** A VitalPBX upgrade that adds,
renames or removes a field appears in Connect the same day with no code change,
and nothing can silently go missing, because there is no list to fall out of.
`conferenceBuilder` already worked this way; this applies the same rule to the
whole console.

⛔ **The moment somebody types a panel field name into `panelSchema.ts` or into
the portal, the two can drift — and the drift is silent, because a missing field
looks exactly like a field that never existed.**

**What that comes to, measured:** **289 fields**, **1,411 dropdown options**,
**7 repeat-row tables**, **26 section headings**, across **19 tabs** in 7 modules.

| Module | Panel class | Fields | Tabs |
|---|---|---|---|
| Tenants | `tenants` | 38 | General · Calls & SMS Routing · Settings |
| Extensions | `extensions` | 103 | General · Voicemail · Recording · Advanced · Follow Me · Incoming Routes · Contact Info |
| Trunks | `trunks` | 69 | General · Advanced · Dialing Manipulation Rules |
| Outbound Routes | `trunk_group` | 12 | General |
| Route Selection | `ars` | 1 + members table | General |
| Ring Groups | `ring_group` | 18 | General |
| Queues | `queues` | 48 | General · Announcement Settings · Others |

⛔ **The panel class names are not the screen names** and two are actively
misleading: an **outbound route** is `trunk_group`, and **route selection** is
`ars`. A **trunk** is `trunks`. Getting these round the wrong way loads the wrong
form and reads like the panel is broken.

---

## 2. Where it lives

- **`apps/api/src/pbxConsole/panelSchema.ts`** — a rendered panel form → what a
  browser would SHOW. `parseSchema()` / `describeForm()` / `schemaFieldNames()`.
- **`apps/api/src/pbxConsole/panelFormWrite.ts`** — an edited form → the pairs a
  browser would POST. Pure: no session, no network, no database.
- **`apps/api/src/pbxConsole/panelForm.ts`** — unchanged in purpose, but
  **`DEVICE_FIELDS` moved here** so the pure write module can use it without
  dragging the api's database layer in. `pbxConsoleWrites` re-exports it.
- **Routes** (both `requireOwner`, i.e. SUPER_ADMIN):
  - `GET  /admin/pbx-console/panel/:module/form?id=&tenantPath=`
  - `POST /admin/pbx-console/panel/:module/save`
- **`apps/portal/.../pbx-console/PanelForm.tsx`** — renders the schema. Every
  module's **Edit** and **New** now open it.
- **`scripts/pbx/mirror/unlicensed-console-proof.ts`** — the licence proof (§4).

⛔ **The GET deliberately does NOT go through `withPanel`.** That helper ends in
`applyAndRebake`, which is a whole-PBX Apply Changes — merely *opening* a form
would regenerate every tenant with pending changes and re-bake the Connect
doorway. Opening a form is a GET in the panel and stays one here.

---

## 3. ⛔ The four parser traps, each now a test

Every one of these failed against the real forms first. They are in
`panelSchema.test.ts` against a **synthetic** fixture — the real forms carry every
customer's company name in their option lists (the outbound-route trunk picker
alone lists 69) plus a live CSRF token, and none of that belongs in git.

1. **Scanning controls must be an ALTERNATION, never an optional group.** The
   obvious `<(select|input|textarea)\b([^>]*?)>(?:(.*?)<\/select>)?` is a trap in
   *both* directions. **Greedy**, the optional group runs from an `<input>` to the
   next `</select>` and swallows every field between — it hid a whole "Last
   Destination" section and a queue member column. **Lazy (`??`)**, the group never
   participates, so every `<select>` comes back with **zero options**. Both were
   hit for real, hours apart.
2. **A `form-group` block runs to the NEXT `form-group`**, so the last one in a
   tab swallows whatever follows it. The control belongs to a label only if it is
   the **first** in the block — ignoring this filed the `no_release` checkbox as a
   destination dropdown and lost the real checkbox.
3. **Bare controls under `<div class="legend">` have no form-group wrapper.**
   "Last Destination" is the standing example; dropping it loses the destination of
   every ring group and queue. Note it is a **div with class `legend`**, not a
   `<legend>` tag — an earlier pass concluded "the panel has no section headings"
   because of exactly that.
4. **A radio button-group is a real, visible field.** `technology`
   (PJSIP / IAX2 / VIRTUAL / TENANT) is rendered as one radio per choice inside a
   Bootstrap button group, the choice's name being the text *after* the input.
   Treating radios as "re-posted from the pairs, never drawn" silently dropped the
   single most consequential field on both the extension and the trunk form.

---

## 4. ⛔⛔ THE LICENCE PROOF — and it corrects a recorded "fact"

Run: `scripts/pbx/mirror/unlicensed-console-proof.ts`, against the
**Community-edition clone** (docker `vpbx-clone` on loopcom, panel published at
`127.0.0.1:8443`, `/var/lib/pbx-licenses` **empty** = never licensed). It drives
the **shipped** code — `describeForm` → `buildPanelEditPairs` → `session.post` —
so a pass is a statement about the real path, not a test double. For each module:
read the form, change one real field, save, **re-read and assert it stuck**, then
put the original value back.

⛔ It refuses to run against a live host by IP.

**Six of seven modules pass, unlicensed, written and read back:**

```
PASS tenants           wrote "A plus center zz" and read it back; restored
PASS trunks            wrote "Addb Builders zz" and read it back; restored
PASS outbound-routes   wrote "Addb Builders zz" and read it back; restored
PASS route-selections  wrote "none zz"          and read it back; restored
PASS ring-groups       wrote "main zz"          and read it back; restored
PASS queues            wrote "main q zz"        and read it back; restored
```

✅ **Queues had never been tested unlicensed before** — §11 of the licence-exit
assessment lists it under "NOT tested". It works.

### ⛔⛔ EXTENSIONS DO NOT, AND THE ASSESSMENT SAYS THEY DO

`AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §11 records
*"extension create/edit/delete ✅ works unlicensed"*. **Over the free tier's
12-extension cap, the panel refuses an extension SAVE both ways round:**

| What is posted | What the unlicensed panel answers |
|---|---|
| general fields **+ the rendered device fields** | `"You've reached the maximum number of allowed extensions"` — it reads the save as a device **ADD** |
| general fields **only** | its own validator crashes: `Undefined array key "user" at /usr/share/vitalpbx/www/modules/extensions/Validations.php` |

Both observed on the clone, from the shipped code path, with the clone at 120
extensions. **There is no third shape**: `pbxConsoleWrites.ts` already documents
that *"there is no general-only post: the panel's save ALWAYS carries a device
sub-form"*.

**Why the assessment reads otherwise:** what it proved was `addExtensionToTenant`,
which **creates** via CSV import (`menu4`), and one device *add*. Neither is an
extension **edit** of an existing record. The two are different controllers.

**What this means for the licence exit — this is the load-bearing consequence:**
editing an extension is the single console operation that stops working the day
the licence lapses. `mirror_writes.py` has `add_extension` but **no edit writer**;
that is the gap to close. Everything else in the console survives.

**What shipped in the meantime:** the cap now surfaces as a plain-English **409**
— *"The phone system's free edition will not save an extension while it is over
its own 12-extension limit — this is the phone system refusing, not Connect.
Nothing was changed."* — instead of a 500 that reads like Connect broke.

### The extension save's one accepted shape

The generic route **hands extensions to `saveExtension`**, which is proven on
production and posts general fields **plus each device's fields taken from THAT
DEVICE'S OWN form** (`method=getDevice`), carrying `user`, `device_id` and the
**dtmf from the database**. ⛔ Never re-post the *rendered* device fields: this
repo already records that doing so flips a desk phone from `rfc4733` to `rfc2833`.
No second implementation was written.

---

## 5. ⛔ A panel save that TIMES OUT has still landed

The first proof run reported `FAIL tenants: The operation was aborted due to
timeout` (the client's 30 s cap in `panelClient.ts:107`). **The write had gone
through.** Because the harness treated it as a failure, the restore never ran and
the clone kept a polluted description until it was put back by hand.

This is the same lesson as the VoIP.ms rotation already in `CLAUDE.md`: **a
timeout is "I stopped listening", never "it did not happen".** Any retry here must
re-read before re-writing. The tenant form is the slow one — it carries 672
options, most of them the timezone list.

---

## 6. Other things worth carrying

- ⛔ **The credentials file `/etc/connect-robot/credentials.env` cannot be
  `source`d.** The robot password contains `(`, `*`, `#`, `>` and `;`, so the shell
  dies with a syntax error **and prints the password**. Read it with a parser, not
  the shell. ⏳ **It leaked into a session transcript this way on 2026-08-21 —
  rotating the robot panel password was already an open TODO and is now overdue.**
- ⛔ **Do not scp files into `/opt/connectcomms/app`.** An untracked file there
  blocks the next deploy's `git checkout -B`. The proof harness runs from
  `/root/console-proof/`, a standalone tree — `panelClient.ts` has **no imports at
  all**, so the whole harness needs 5 files and no packages.
- ⛔ **Heredoc'd Python patches ate `\b` three times**, writing a literal backspace
  (0x08) into the regex so it could never match, while `sed` output *looked*
  correct. If a regex mysteriously matches nothing, check for control bytes:
  `python3 -c "print([b for b in open(f,'rb').read() if b<9])"`. Rewriting the file
  whole was faster than patching it a fourth time.
- **The mockup and the shipped screen come from one source.** The artifact is
  generated by the **same `parseSchema`** the api runs, so they cannot disagree:
  <https://claude.ai/code/artifact/66bb5c11-700c-43b7-a4b2-d2d36404fff3>

---

## 7. Deploy state and what is NOT proven

- api + portal deployed from the branch tip `39902d81` — **verify the containers
  before trusting this line** (`docker exec app-api-1 cat /app/.build-commit`).
- ⏳ **NOT PROVEN: nobody has opened the new form in a browser.** It is proven as
  50 tests, a clean portal typecheck, an api typecheck at its exact 75-error
  baseline, and 6 of 7 modules written and read back on the unlicensed clone —
  **not** by a human saving a record from the screen.
- ⏳ **No write has been made from the console against PRODUCTION** on this path.
  The acceptance test is small: open **Trunks → Edit** on Loopcom Demo 2, change
  the description, save, reopen. Then the negative that matters — **Extensions →
  Edit still saves on production** (the licence is live, so the cap does not fire).
- ⏳ **File uploads are not wired.** The panel takes a file on two fields (the
  outbound-route CSV, the extension photo); the form says so in plain words rather
  than drawing a control that does nothing.
- ⏳ **Creating an extension from the generic form is refused on purpose** — it
  needs its devices built too, which the Extensions screen already does.

---

# §8. THE FULL UNLICENSED STRESS RUN (2026-08-21, same day) — every field, every table, every button; three real bugs found and fixed; and the ONE build left before the licence can be cancelled

Izzy: *"stress the fuck out of everything we moved over from the PBX to Connect
that is not covered by the license … every little field, every button,
everything that we created should be working, and wired with the PBX. Make it
ready for me to completely disconnect."*

**Harnesses (all in `scripts/pbx/mirror/`, all refuse to run against a live
host):** `stress-console-fields.ts` (the full sweep, 4 phases),
`stress-retest-fails.ts` (focused re-judge of failures),
`unlicensed-console-proof.ts` (§4's original per-module proof).
**Run recipe:** `/root/console-proof/` on loopcom + `run*.py` wrappers, which
read `/etc/connect-robot/credentials.env` WITH A PARSER (⛔ never `source` it —
§6). Clone ids: MAIN `2dc3974017c1bc65`, tenant `f3df739ac62197cd` (t2),
trunk 11, route 11, ars 1, rg 1, queue 1, ext 1.

## 8.1 The final numbers (sweep v3 + the retest, unlicensed clone, shipped code)

| Module | PASS | Panel refusals (validation working) | Documented skips | FAIL |
|---|---|---|---|---|
| tenants | 29 | 1 | 0 | 0 |
| trunks | 53 | 6 | 17 | 0 |
| outbound-routes | 11 | 0 | 5 | 0 |
| route-selections | 3+2* | 0 | 0 | 0* |
| ring-groups | 14 | 0 | 5 | 0 |
| queues | 43+4* | 0 | 8 | 0* |
| extensions | form + cap probe | — | — | 0 |
| render-to-Asterisk | 2 | 0 | 0 | 0 |

\* the sweep's 3 residual "FAIL"s are HARNESS artifacts (duplicate key values;
`"0"+"9"="09"` vs the panel's int-cast) — the identical operations PASS in
`stress-retest-fails.ts` with distinct values: queue member penalty 0→1→0 with
`member_id` preserved, queue member add/remove, ars member add/remove. Sweep v4
carries the probe fixes; read `/root/console-proof/stress-fields.log` for its
result before quoting numbers.

**Creates and deletes, all proven in the phone system's own MySQL, then
deleted and proven gone:** trunk #134, outbound route #131, route selection
#226, ring group #116, queue #10 (with one member row — see 8.4).

**Wired to Asterisk:** queue member ring time changed → panel Apply → the new
value grepped out of the RENDERED `queues__*` file inside the clone → restored
→ re-applied. The database is not what callers hear; the rendered file is, and
it moved.

**Panel refusals are the wiring WORKING:** "Simultaneous Calls must consist of
integer value", "You must provide a valid IP/Domain", "The format must be
sip:sip.example.com." — the panel's own validator answering through our path,
field by field.

## 8.2 ⛔⛔ THE THREE REAL BUGS THE RUN CAUGHT (all fixed, commit `b10151fd`)

1. **A row is more than its visible cells.** Existing rows carry HIDDEN pairs
   the template never draws — `queue_members[N][member_id]` — and they are how
   the panel tells "update this member" from "add one". Rebuilding rows from
   the visible cells alone made `queues.php` throw
   `Undefined array key "member_id"`. Row objects now carry EVERY concrete pair
   of their group (portal `readRows` collects them generically; the builder
   emits each in the panel's own shape). ⛔ A new row must NOT carry an id —
   that is what makes it an add; the builder fills hidden template defaults
   (`member_id=""`) instead.
2. **The placeholder row is part of the post.** A browser submits the template
   row itself — literal `{{row-count-placeholder}}` index and all — and the
   save controller requires the array key to exist: a queue created without it
   dies on `Undefined array key "queue_members"`. `teamBuilder.createQueue` has
   posted it since the day it shipped (its own comment says "the form expects
   it"). The generic builder now posts it for edited groups AND for groups the
   caller never touched (the create case).
3. **Concrete underscore-shaped row cells leaked into the field list.**
   `queue_members_0_extension_id` has no brackets, so the loose-control scan
   drew every member row twice — once in the table, once as a stray field.

## 8.3 ⛔ PANEL SEMANTICS, DB-PROVEN — never "fix" these

Judged at the DATABASE (save accepted → ombu row byte-identical), because the
panel renders their real state via ITS OWN JavaScript and raw HTML re-reads are
structurally blind there:
- **trunks:** `tenant_trunk_id`, `outgoing_settings`, `incoming_settings`,
  `outgoing[insecure|type|trunk|qualify]`,
  `incoming[host|secret|remotesecret|insecure|trunk|type|qualify]` — the save
  controller IGNORES these pairs for a PJSIP registration trunk. A browser user
  gets identical behaviour. (Same family as the SignalWire lesson: these are
  the JS-ticked checkboxes that read as absent in raw HTML.)
- **queues:** `hangup_dest_custom` / `destination_custom` persist only when
  their destination dropdown says custom; the panel discards them otherwise.
- The sweep skips all of these WITH the reason, so the table stays honest.

## 8.4 Queue create needs a member — the panel's own rule

"No agents assigned to this queue. Please add at least one agent" — surfaced by
name once the placeholder fix landed (it had been dying as a PHP exception
before it). The generic create passes WITH one member row
(`{extension_id, penalty:"0", type:"dynamic"}`, no member_id). Proven: queue
#10 created with 1 member row in `ombu_queue_members`, deleted clean.

## 8.5 ⛔ OPEN — the two advanced trunk tables (small, real, recorded)

**trunk Custom Parameters (`trkcustom`) rows do not persist through the generic
re-post** — DB-verified: save accepted, `ombu_trunk_parameters` unchanged, even
with a valid shape (`friend/qualify_timeout/4.0/enabled`). **Custom Headers
(`trk-headers`) show a form-vs-DB disagreement** (an added row appeared and
"removed" on the form while a `header X-ZZ-Stress` DB row lingered; residue
cleaned by hand). The panel's own JS does something on these two tables the
re-post does not reproduce. **No Connect writer has ever used them**
(`createTrunk` posts them empty) and no fleet trunk carries one. To close:
capture a real browser session of a human adding a Custom Parameter in the
panel and diff the post.

## 8.6 ⛔⛔ THE ONE BUILD LEFT BEFORE DISCONNECTING: the mirror EXTENSION EDIT-WRITER

**This is the next agent's job, and the only thing standing between Izzy and
cancelling the subscription.** §4 proved the free panel refuses an extension
EDIT over the 12-extension cap, both ways round, and the fleet holds 119.
Everything else survives the lapse (six modules proven end to end; tenant
CREATE already goes through the mirror).

What to build — `edit_extension` in `scripts/pbx/mirror/mirror_writes.py`,
beside the existing `add_extension`:
- **Write the `ombutel` rows the panel would write** (`ombu_extensions`,
  `ombu_devices`, the voicemail row) — `add_extension` already knows the
  tables; an edit is an UPDATE of the same columns.
- **Re-render with the byte-identical generator** (`vitalpbx_mirror.py` —
  `render_and_install_pbx` / the surgical helpers `surgical_pjsip`,
  `surgical_voicemail`, `surgical_astdb`, `surgical_hints` already exist for
  the ADD case; an edit regenerates the same files + AstDB keys).
- **Acceptance, on the clone first:** edit an extension's name/email/vm
  password via the mirror on the UNLICENSED clone → `diff` the regenerated
  `extensions__50-<t>*`, `pjsip__50-<t>*`, `voicemail__50-<t>*` files against
  what the LICENSED panel produces for the same edit → 0 differences; then
  `pjsip show endpoint` inside the clone. Then wire
  `pbxConsoleRoutes`' extension branch to FALL BACK to the mirror when the
  panel answers the cap refusal (the 409 `maximum number of al` case) — the
  console then works identically before and after the lapse.
- ⛔ **The rest of the licence-exit checklist still stands** (the assessment
  doc's §10/§11): one real phone-registers-and-calls test on a mirror tenant,
  and the free-tier items never tested. **Do not cancel on the strength of this
  handoff alone — build the edit-writer, prove it on the clone, then re-read
  the assessment's "before cancelling" list.**

## 8.7 Deploy + hygiene state at handoff

- api `a9008ac1` (contains everything through `b10151fd`) deployed; a portal
  follower (`/root/follow-portal-deploy.sh` → `/root/dep-portal-rowfix.log`)
  was armed to carry the row fix — verify `app-portal-1`'s `.build-commit`
  CONTAINS `b10151fd` before trusting the portal's row editing.
- ⛔ **The robot panel password rotation is OVERDUE** — it leaked into a session
  transcript on 2026-08-21 (the un-sourceable credentials file, §6).
- ⛔ **The `pgrep` self-match trap bit AGAIN, twice, in this very engagement** —
  an unbracketed `pgrep -f stress-console-fields` waiter spun for 1h14m and then
  became the thing later checks matched. `pgrep -f "[s]tress…"` always.
- ⛔ **A killed harness leaves a mutated field on the clone.** The 90-second
  smoke kill left `ombu_tenant_settings.trunks="zz"` on clone t2, repaired by
  hand. Never kill the sweep mid-field; if you must, sweep the clone for `zz`
  values after (the harness's own restore verifies otherwise).
