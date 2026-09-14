# ⛔⛔ AGENT HANDOFF — the IVR migration's red "Connect can't reproduce these" list is MOSTLY A FALSE ALARM, and the two-line real list hides DISA (2026-08-24) — READ FIRST before migrating ANY customer's IVR, before believing that dialog, or before decoding an `ombu_destinations` row

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_MIGRATION_RED_LIST_2026-08-24.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**
Every fact read from the live PBX 2026-08-24, config from `ombutel` and behaviour from
the **rendered dialplan**.) Izzy, 2026-08-24: *"I want to start migrating people's IVRs
into Connect, and I'm getting this."*
Memory: [[ivr-migration-red-list-is-mostly-a-false-alarm]].

- ⛔⛔ **THE HEADING CONTRADICTS ITS OWN ROWS.** `buildImportPlan` files every
  **multi-digit** IVR entry as a `problem` unless the PBX menu already has
  dial-by-extension on (`ombu_ivrs.freedial`). Most customers have it **off**, so their
  per-extension shortcuts (101, 102, 103…) render under a red *"Connect can't reproduce
  these"* heading — while each row's text says *"Connect can do the same if you switch
  dial-by-extension on"*. **Fleet-wide: 41 reproducible extension shortcuts vs 10 genuine
  losses.** B Visible shows **13 red rows and only 2 are real.**
- ⛔⛔ **IT IS NOT PURELY COSMETIC, AND THIS IS THE HALF TO GET RIGHT.** `planFor`
  copies `directDialEnabled` **as-is**, so a menu that was off on the PBX arrives in
  Connect off — and **callers who dial 103 at that menu today stop being able to.**
  The honest framing is **"one switch away, and the copy will not flip it for you."**
  ✅ The switch really does reproduce it, verified live: `_XXX` / `_XXXX` in
  `connect-menu` (`extensions__60_custom.conf:443/452`) gated on `M_DIRECT_DIAL`, which
  also moves `TIMEOUT(digit)` **0.2 s → 1 s** — without which multi-digit entry cannot
  work at all. ⛔ The caveat is real and is the customer's call: Connect then accepts
  **any** 3–4 digit extension, not only the ones the PBX menu listed (for B Visible that
  adds 107 and the virtual forwards 108/109/110, which ring outside numbers).
- **The census, so nobody re-derives it:** *dial-by-ext ON* — A plus center (12 kept
  silently, only `1818` red), Relax Tires, Solidify, Trust. *OFF* — **Gesheft 16**,
  **B Visible 11**, Displaydex 2.
- ⛔ **The 10 genuine ones are all real features, none of them dead:** four are **DISA**
  (`0478` B Visible, `7879` Solidify, `1708` Trust, plus B Visible's `vacation` menu) —
  dial the main number, enter the code, **get dial tone and place outbound calls
  presenting the company's caller ID**; two jump straight to a voicemail box
  (`55648752` → VM 101, `1159` → VM 101); **Gesheft's `750` and `13132` both jump into
  queue 750 — Phone Orders, their busiest (~2,020 calls/30 d)**; `303` → a custom
  application; `1818` → ring group 1010. **Confirm with the customer before copying a
  menu that carries one** — this is the one class where "copy the rest anyway" genuinely
  drops something people use.
- ⛔⛔ **MY FIRST READ OF THOSE 10 WAS WRONG AND THE DIALPLAN CORRECTED IT.** Decoding
  `ombu_destinations` by `module_id`/`index` (module 31 → "ivr") resolved B Visible's
  `0478` to **ivr_id 1, which belongs to A plus center** — it looked like a live
  cross-tenant leak — and three more looked like pointers to menus that no longer exist.
  **All false.** `index` is not an `ivr_id` in that table. **Never turn an
  `ombu_destinations` row into a customer-facing claim without reading the rendered
  context** (`extensions__50-<t>-dialplan.conf`).
- **Copying is gated in TWO places and they must move together:** the portal disables the
  button (`page.tsx:402`) and the API answers **422 `plan_has_problems`**
  (`server.ts:26647`) unless `allowPartial`. The *"Copy the rest anyway"* checkbox sets
  it, so **it does work end to end today.**
- **What to do per customer:** dial-by-ext OFF (B Visible, Displaydex, Gesheft) → tick
  *"Copy the rest anyway"*, copy, then **turn dial-by-extension ON for each copied menu
  in IVR Studio before Go live**. The others have nothing reproducible to worry about.
- ✅✅ **FIXED THE SAME DAY (Izzy's go-ahead) — the list is split.** A "switch
  dial-by-extension on" row is now a **decision on the copy**, not a red blocker:
  `PlannedProfile.directDialWouldRestore` + `ImportPlan.directDialRestorable` carry it,
  the dialog renders **"Extension shortcuts — one switch away"** with a checkbox
  **ticked by default**, and `POST /voice/ivr/migration/import` takes `enableDirectDial`.
  **B Visible goes from 13 problems to 2, Gesheft from 19 to 3, the estate from 51 to 10.**
  ⛔⛔ **The flag RAISES ONLY and is SCOPED**: `p.directDialEnabled || (enableDirectDial
  && p.directDialWouldRestore.length > 0)` — so declining can never switch OFF a menu the
  PBX already had it on for, and ticking can never widen a menu the operator was never
  shown. A source guard reads that one line out of `server.ts` (comments stripped — the
  block above the flag quotes the same wording), because the plan builder can be perfectly
  right and the feature still dead if the route ignores it.
  ⛔ **The checkbox defaults TICKED on purpose**: these codes work for callers today and a
  migration must not break what already works. Unticking states the consequence in the
  same box ("callers who dial these will hear an invalid-option message").
  ⛔ The `allowPartial` gate is UNCHANGED and still fires on the 10 real ones — dropping a
  DISA code or Gesheft's queue shortcut without asking is what it exists to prevent.
  ✅ **39 api tests pass; 5 of them fail replayed against `HEAD`** (3 plan-builder, 2 route
  guards). The third route guard passes at HEAD by design — it pins existing behaviour.
  api typecheck **76 = the exact baseline**, none in an edited file; portal **0**, suite
  350/352 (the two documented pre-existing).
  ⛔ **The heredoc control-character trap bit again writing those guards** — `
` inside
  a Bash heredoc landed as REAL newlines and broke the string literals. Written through
  the editor with `String.fromCharCode(10)` instead. It is in this file twice already.
- ✅✅ **THE "10 GENUINE LOSSES" ARE NOT LOSSES ANY MORE (2026-08-25, `316e6dbb`, Izzy:
  "fix it. It's the IVR." — handoff §9): Connect menus CARRY hidden 3–8 digit dial
  codes now, and B Visible plans CLEAN.** A code is an ordinary `IvrOptionRoute` row
  whose `optionDigit` IS the code (no schema change; rule shared in
  `apps/api/src/ivrMenuCodes.ts`), published as
  `connect/t_<slug>/menu/<id>/code_<digits>/dest|type` + `has_codes` (which widens
  `TIMEOUT(digit)` to 1s), matched by `[connect-menu]`'s `_XXX`..`_XXXXXXXX` patterns
  AHEAD of direct dial, and routed to the IDENTICAL Goto the PBX's own literal exten
  used (`0478 → T9_app-disa,DISA-1,1`, `55648752 → sub-extensions-vm,VM-101,1`, both
  read from the rendered dialplan). The migration planner turns every mappable code
  into a carried option + `plan.carriedCodes`; only out-of-range (>8 digits) or
  broken-target codes stay problems. **api + portal DEPLOYED + container-verified;
  PBX dialplan patched live** (`scripts/pbx/patch-connect-menu-codes.sh`, backup
  `.bak.menucodes.20260825T111217Z`, parse PROVEN via `dialplan show`).
  ⛔⛔ **Codes are the one VARIABLE part of the published key slate — BOTH publish
  paths append `""` tombstones (`collectStaleIvrCodeTombstones`, diffed against the
  last successful IvrPublishRecord) or a DELETED dial-through code keeps answering
  forever.** Never remove those calls; live-proven (delete + republish blanked the key).
  ⛔ Codes work only on menus served through `[connect-menu]` (didmap/per-number = every
  migrated menu); the legacy `[connect-tenant-ivr]` path was deliberately not touched.
  ✅ **PROVEN WITH A REAL CALL** on Loopcom Demo: real DTMF `0478` through AMI →
  `Connect menu code … type=voicemail` → `VM-101@sub-extensions-vm`. And the deployed
  plan route for B Visible (pbxTenantId 9, ivrs 25/24) answers **`problems: []`** with
  both codes under `carriedCodes` — the red section is gone and Copy is not blocked.
  Studio shows code rows as removable 🔑 steps (an invisible row that routes calls is
  how a "removed" code survives).
  ✅✅ **STRESS-TESTED 2026-08-25 (`5133b52f`, api DEPLOYED — handoff §10) AND IT FOUND
  ONE REAL HOLE: a FAILED publish could shield a deleted code from its tombstone.**
  The record is created BEFORE the AstDB write, so a failed/pending publish may have
  written any prefix of its keys — baselining the diff on the last SUCCESS alone let a
  code that landed via a failed publish and was then deleted answer forever. The
  wrapper now diffs against every record since (and incl.) the last success (take 25).
  Found by the 300-run lifetime simulator with failure injection, which required moving
  the slate + diff into `ivrMenuCodes.ts` as pure functions — ⛔ **server.ts cannot be
  imported by tests, so logic left inline there is logic nobody can drive.** Also
  proven live: 9 hostile bodies refused (forged body tenantId IGNORED), 5-way
  concurrent publish burst consistent, 5 real-DTMF probes (code precedence with
  direct-dial off, 8-digit, wrong code → told invalid, 0.5s-gap typing, single keys
  unbroken), deleted code dead ON THE WIRE with 0.2s timing restored. ⛔ The NUL trap
  bit AGAIN writing hostile fixtures (`Bin` in the staged stat is the tell); NULs in
  test data go through `String.fromCharCode(0)`.
- ⏳ **NOT PROVEN: nothing has been copied and no number has been flipped, and no HUMAN
  has dialled a carried code on a live migrated number** (the probe entered the menu
  directly, not through a DID). **The acceptance test for any migration is a real
  call** — dial the number, press a key, dial an extension, and dial the hidden code
  at the menu.
