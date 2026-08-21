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
