# IVR migration — "Connect can't reproduce these" is mostly a FALSE ALARM (2026-08-24)

**Read-only investigation — no code change, no deploy, no PBX write, no data change.**
Every fact below was read from the live PBX on 2026-08-24: `ombutel` for config, and
the **rendered dialplan** (`/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf`)
for what callers actually get.

Izzy, 2026-08-24: *"I want to start migrating people's IVRs into Connect, and I'm
getting this."* — the red **CONNECT CAN'T REPRODUCE THESE** list on B Visible's
"What copying this menu will do" dialog.

## 1. What the red list actually is

`buildImportPlan` (`apps/api/src/ivrMigration.ts:636`) files every **multi-digit**
IVR entry. It silently keeps one — as `keptByDirectDial` — only when **all three**
hold:

```js
if (ivr.directDialEnabled && isTenantExtension && lengthMatchesDirectDial) { … }
```

⛔ **`ivr.directDialEnabled` is the PBX's own `ombu_ivrs.freedial` column.** B Visible's
**Main and After Hours both read `freedial = no`**, so all 11 of their extension
shortcuts (101–106) fall through into `problems` — and `problems` is rendered under a
red *"Connect can't reproduce these"* heading and **disables the Copy button** until
the operator ticks *"Copy the rest anyway"* (portal `page.tsx:402`, and the API
enforces it too: `server.ts:26647` → 422 `plan_has_problems`).

⛔ **The rows contradict their own heading.** Their text reads *"Connect can do the
same if you switch dial-by-extension on for this menu"* — i.e. reproducible — while
sitting under a heading that says it cannot be. That is the whole reason this reads
as a blocker.

## 2. …but it is NOT purely cosmetic, and this is the part to get right

`planFor` copies `directDialEnabled: ivr.directDialEnabled` **as-is**. B Visible's is
`no`, so the copied Connect menu also has dial-by-extension **off**. **Callers who
dial 103 at that menu today would stop being able to** once the number goes live.

So the honest framing is **not** "false alarm" — it is **"one switch away, and the
copy will not flip it for you."**

✅ **The switch really does reproduce it — verified live, not assumed.**
`extensions__60_custom.conf` carries `_XXX` (line 443) and `_XXXX` (452) in
`connect-menu`, gated on `M_DIRECT_DIAL` from the AstDB `direct_dial` key. Turning
dial-by-extension on also moves `TIMEOUT(digit)` from **0.2 s → 1 s** (line 474),
which is what makes multi-digit entry possible at all.

⛔ **The caveat is real and belongs to the customer:** Connect's pattern accepts **any**
3- or 4-digit extension, not only the ones the PBX menu listed. For B Visible that
additionally exposes 107 and the virtual forwards 108/109/110 ("102 V", "104 V",
"101 V" — each rings an outside number) and 111.

## 3. Fleet census — every multi-digit code on the PBX

| Customer | PBX dial-by-ext | Extension shortcuts (reproducible) | Genuinely NOT reproducible |
|---|---|---|---|
| A plus center | **ON** | 12 — silently kept, **no red rows** | `1818` → ring group 1010 |
| B Visible | off | **11** (101–106) | `0478` → **DISA** · `55648752` → voicemail on ext 101 |
| Gesheft | off | **16** (101–118) | `750` + `13132` → **queue 750** · `303` → custom application |
| Displaydex | off | 2 (102, 104) | — none — |
| Relax Tires | ON | 0 | `1159` → voicemail on ext 101 |
| Solidify Concrete | ON | 0 | `7879` → **DISA** |
| Trust Bookkeepings | ON | 0 | `1708` → **DISA** |

**Totals: 41 extension shortcuts (all reproducible) vs 10 genuine losses.**

⛔⛔ **MY FIRST READ OF THESE 10 WAS WRONG AND THE DIALPLAN CORRECTED IT.** Decoding
`ombu_destinations` by `module_id`/`index` (module 31 → "ivr") resolved B Visible's
`0478` to **ivr_id 1, which belongs to A plus center** — i.e. it looked like a live
cross-tenant leak, and `55648752`/`1818`/`1159` looked like dangling pointers to
menus that no longer exist. **All of that is false.** `index` is not an `ivr_id` in
this table. The rendered dialplan shows `0478` is
`Goto(T9_app-disa,DISA-1,1)` and `55648752` is `Goto(sub-extensions-vm,VM-101,1)`.
**Never decode an `ombu_destinations` row into a customer-facing claim without
checking the rendered context.**

## 4. The four DISA codes — worth Izzy's attention on their own

`0478` (B Visible), `7879` (Solidify Concrete), `1708` (Trust Bookkeepings) and
B Visible's `vacation` menu all land in `T<n>_app-disa`, which does:

```
Gosub(authenticate,s,1(<pin>))
DISA(no-password,T<n>_cos-all,"<company>" <did>)
```

i.e. **dial the main number, enter the code, get dial tone and place outbound calls
presenting the company's caller ID.** That is a real feature staff may rely on, and it
is also the classic toll-fraud surface. Connect menus have no equivalent, so migrating
those menus removes the menu-side entrance to it. ⛔ **Confirm with each customer
before migrating a menu that carries one** — this is the one class here where "copy the
rest anyway" genuinely drops something people use.

## 5. Gesheft is the one to be careful with

`750` and `13132` both `Goto(T8_ext-queues,750,1)` — that is **Phone Orders**, their
busiest queue (~2,020 calls / 30 days, 92% answered). Two secret codes jump straight
into it, bypassing the menu. Losing them is a real change for whoever uses them.
Gesheft also has the largest reproducible set (16) and dial-by-extension **off**.

## 6. What to do today, per customer

- **B Visible / Displaydex / Gesheft** (dial-by-ext OFF): tick *"Copy the rest anyway"*,
  copy, then **turn dial-by-extension ON for each copied menu in IVR Studio before Go
  live**. Otherwise the listed extensions stop working from the menu.
- **A plus center**: cleanest — its 12 shortcuts are already kept silently; only `1818`
  shows red.
- **Relax Tires / Solidify / Trust**: nothing reproducible to worry about; each has
  exactly one real code to decide on.

## 7. BUILT (2026-08-25) — the list is split

Izzy's go-ahead the same session. **Code complete, tests green, ⏳ NOT DEPLOYED.**

**`apps/api/src/ivrMigration.ts`** — the branch no longer files an extension shortcut
as a problem at all. It splits on whether the switch is already on:

- already on → `ImportPlan.keptByDirectDial` (silent, unchanged)
- off → `PlannedProfile.directDialWouldRestore` + the `ImportPlan.directDialRestorable`
  roll-up, built **from `profiles`** so the screen and the write can never disagree
  about which menus the copy touches

`problems` now holds only the genuinely inexpressible ones. The three-way `reason`
ternary collapses to one message, because the reproducible arms are unreachable.

**`apps/api/src/server.ts`** — `POST /voice/ivr/migration/import` takes
`enableDirectDial`, and the profile write becomes:

```ts
directDialEnabled: p.directDialEnabled || (body.data.enableDirectDial === true && p.directDialWouldRestore.length > 0)
```

⛔⛔ **Raise-only and scoped, and both halves are load-bearing.** The PBX value is
**ORed, never replaced**, so declining the checkbox cannot switch OFF a menu the PBX
already had it on for. And the flag only reaches menus whose plan actually lists codes
to restore, so ticking cannot widen a menu the operator was never shown.
⛔ The `allowPartial` gate is **unchanged** — the 10 real ones still stop the copy.

**`apps/portal/.../ivr-migration/page.tsx`** — new section *"Extension shortcuts — one
switch away"*, listing menu + codes, with a checkbox **ticked by default** and a line
underneath that changes with the state to name the consequence either way.
⛔ Default ticked because these codes work for callers **today** and the standing bar is
that a migration must not break what already works.

### Proof

- **39 tests in `ivrMigration.test.ts`; 5 fail replayed against `HEAD`** — 3 plan-builder
  and 2 route guards. ⛔ The third route guard (*"the copy still stops on genuinely
  unreproducible keys"*) **passes at HEAD by design**: it pins behaviour that must not
  change. Reported as 5 of 6, not 6 of 6.
- ⛔ **The guards read `server.ts`'s SOURCE**, comments stripped — the doc block above the
  flag quotes the very wording they match, so a naive check would pass on the comment.
- api typecheck **76 = the exact baseline**, none in an edited file; portal **0**;
  portal suite **350/352** (the two documented pre-existing failures).
- ⛔ **The heredoc control-character trap bit again.** `
` written into the guard through
  a Bash heredoc landed as REAL newlines and broke the TS string literals (`TransformError`,
  which reads like a broken test). Rewritten through the editor using
  `String.fromCharCode(10)`. **This is in CLAUDE.md twice already; write escapes through
  the editor.**

### Numbers

| | problems before | problems after |
|---|---|---|
| B Visible | 13 | **2** |
| Gesheft | 19 | **3** |
| Displaydex | 2 | **0** |
| whole estate | 51 | **10** |

## 8. NOT PROVEN

⏳ **Nothing is deployed, nobody has opened the dialog, and no menu has been copied.**
Proven as tests, typechecks and a HEAD replay — never as a screen a person used.

**Acceptance, and the negatives matter most:**
1. Open B Visible's Main in IVR Migration → the red list reads **2 rows** (`0478`,
   `55648752`), and the new section offers **101–106** with the box ticked.
2. Copy with it ticked → the copied menus read **dial-by-extension ON** in IVR Studio.
3. ⛔ **Untick and copy → they must come across OFF**, exactly as the PBX has them.
4. ⛔ **A plus center must show NO new section** — its menus already have the switch on,
   so there is nothing to decide, and its 12 codes stay in *"Extension shortcuts — kept"*.
5. ⛔ **The Copy button must still be disabled** on B Visible until *"Copy the rest anyway"*
   is ticked — the DISA code is a real loss and must still stop the operator.
6. Then the only proof that counts: **a real call.** Dial the number, press a key, and
   dial an extension at the menu.

## 9. BUILT AND DEPLOYED (2026-08-25, `316e6dbb`) — hidden codes are CARRIED now; the red list is EMPTY for every mappable code

Izzy, looking at B Visible's residual two red rows (`0478`, `55648752`): *"Be
visible. fix it. It's the IVR."* So the last genuine losses became a feature:
**a Connect menu holds hidden 3–8 digit dial codes.**

### The mechanism, end to end

- **Storage**: an ordinary `IvrOptionRoute` row whose `optionDigit` IS the code
  (`"0478"`). The column was always a plain string — **no schema migration**.
  The rule lives once in `apps/api/src/ivrMenuCodes.ts` (`/^\d{3,8}$/`), shared
  by the planner and the publish path so the two can never disagree.
- **Planner** (`ivrMigration.ts`): a mappable 3–8 digit non-extension code is a
  `PlannedOption` + a `plan.carriedCodes` rollup (informational — the dialog
  names a DISA code for what it is). Out-of-range or broken-target codes stay
  `problems`. Extension shortcuts keep the dial-by-extension decision exactly
  as §7 built it.
- **Publish** (`buildIvrKeys`): per-menu family gains
  `code_<digits>/dest|type` + `has_codes`. ⛔ Codes are the one VARIABLE part
  of the published key slate, so BOTH publish paths append `""` tombstones
  (`collectStaleIvrCodeTombstones`, diffed against the last successful
  `IvrPublishRecord`, non-empty previous values only so tombstones never
  re-propagate) — without this a DELETED dial-through code keeps answering.
- **Dialplan** (`scripts/pbx/patch-connect-menu-codes.sh`, applied to the live
  PBX 2026-08-25, backup
  `extensions__60_custom.conf.bak.menucodes.20260825T111217Z`): the
  `_XXX`/`_XXXX` heads in `[connect-menu]` check `code_${EXTEN}/dest` FIRST
  (code beats direct dial — the same precedence a literal exten has over a
  pattern on VitalPBX), new `_XXXXX`..`_XXXXXXXX` patterns are code-only, and
  `TIMEOUT(digit)` widens to 1s when `has_codes` is "1" so an 8-digit code is
  typeable on a direct-dial-off menu. ⛔ `[connect-tenant-ivr]`'s own patterns
  were deliberately NOT touched — codes ride the per-menu family, i.e. every
  didmap-served (= every migrated) menu.
- **Studio**: code rows render as removable 🔑 steps under the key list — an
  invisible row that routes live calls is how a "removed" code survives.
  The option-create route accepts a code-shaped `optionDigit`.
- **Migration dialog**: new "Hidden dial codes — carried over" section; the
  red list shrinks to genuinely unmappable entries only.

### Proof

- 49 planner/rule tests pass (`ivrMigration.test.ts` reworked — the two "still
  reported as lost" tests flipped into carried-code tests — plus
  `ivrMenuCodes.test.ts` with caller-side source guards; all guard strings
  grep 0 on HEAD^). api typecheck 76 = the exact baseline; portal 0.
- api + portal DEPLOYED and container-verified at `316e6dbb` (tombstone helper
  ×4 in the running server.ts, "Hidden dial codes" in the shipped
  ivr-migration chunk).
- **PROVEN WITH A REAL CALL** on Loopcom Demo (T102, menu
  `cmsy43972064hnx14seqgcmp1`): code `0478 → sub-extensions-vm,VM-101,1`
  created through the real option route, published through the real publish
  route (AstDB read back), then an AMI-originated call sent REAL DTMF `0478`
  into the menu — log shows `TIMEOUT(digit)=1`, the code branch
  (`[0478@connect-menu:7] Connect menu code … type=voicemail`),
  `[connect-exit-router]`, and `VM-101@sub-extensions-vm` running voicemail.
  Then the delete + republish blanked `code_0478/dest` and `has_codes` → 0 —
  the tombstones proven live, not just by test.
- **B Visible plans CLEAN through the deployed route**: `POST
  /voice/ivr/migration/plan` for pbxTenantId 9, ivr 25 and 24 both answer
  `problems: []` with `carriedCodes` = `0478 → Dial-through 1` (Main) and
  `55648752 → Voicemail 101 · Front Desk` (After Hours). The Copy button is
  no longer blocked on this customer at all.

### Still not proven

- Nobody has pressed Copy on B Visible, no number there is live on Connect,
  and no HUMAN has dialled a carried code on a live migrated number — the
  probe entered the menu directly, not through a DID. Acceptance stays §8's:
  a real call to the number, dial `0478` at the menu, get dial tone; dial
  `55648752` at the after-hours menu, land in voicemail 101.
- The other estates' codes (Gesheft 750/13132/1159, Solidify 7879, Trust 1708,
  A plus 1818, B Visible's `vacation` DISA) will carry the same way; none has
  been copied yet.
