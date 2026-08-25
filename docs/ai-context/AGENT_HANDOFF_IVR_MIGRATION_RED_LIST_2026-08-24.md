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

## 7. Recommended fix (NOT built — awaiting Izzy)

Split the list in `ImportPlan`. A row whose own text says *"Connect can do the same if
you switch dial-by-extension on"* is **not** a "can't reproduce" and must not sit under
that heading nor block the button. Instead surface it as a decision on the copy:

> ☑ Turn dial-by-extension on for these menus so callers can still dial 101–106
> *(Connect then accepts any extension, not only the ones listed here.)*

…defaulted **ticked**, because the standing bar is that nothing already working may
break. Then `problems` holds only the genuinely-unreproducible rows — for B Visible
that is **2 instead of 13**, and for the whole estate **10 instead of 51**.

⛔ Blast radius traced: `problems` is read in three places — the portal preview
(`page.tsx:402/486`), the portal's 422 error banner (`:509`), and the API gate
(`server.ts:26645/26647`). All three must move together or the button and the server
will disagree.

## 8. NOT PROVEN

No menu has been copied and **no number has been flipped to Connect** in this session.
Everything above is read-only measurement. The acceptance test for any migration is
still a **real call**: dial the number, press a key, and dial an extension at the menu.
