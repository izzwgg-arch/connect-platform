# ⛔⛔ AGENT HANDOFF — the device setup wizard (ANY VoIP device, not just desk phones) is BUILT END TO END and DEPLOYED (api + portal, 0 rows — inert until somebody opens it); there was never a local agent, and the LAN scanner was in an app nobody has (2026-08-21→22) — READ FIRST before believing the Windows app can reach a customer's network, before writing a second Electron app or Windows service, before touching `provisioning.devices.keys`, or before quoting a phone's timezone

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md`**
(`05763764` and its ancestors on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified; migration applied 2026-08-21 23:51:16Z. No PBX write, no env change, no
tenant row.** Every PBX touch was a read-only SELECT or a file copy. Approved mockups:
<https://claude.ai/code/artifact/7a561ef4-9624-4afa-ad19-d59ad9ae4252>.)
Izzy, 2026-08-21: *"Install Connect and press Set Up My Phones"* — and *"the agent always has
to do everything in his power to get every single phone connected."*

- ⛔⛔ **THE PREMISE THAT IS FALSE, AND THE WHOLE DESIGN RESTS ON IT: `apps/desktop` HAS NO
  LOCAL AGENT.** `preload.ts` exposes exactly four namespaces — `window`, `phone` (the SIP
  engine), `notifications`, `updates` — and `main.ts` registers 12 `ipcMain` handlers, all
  window/update/phone. **There is no command channel, no LAN access, no shell.** ⛔ And
  "the agent" in this repo is **`apps/agent`, the AI container on loopcom in France**, which
  has no route into a customer's office. Do not plan around a local agent that exists.
- ⛔⛔ **A WORKING LAN SCANNER EXISTS IN AN APP THAT HAS NEVER BEEN SHIPPED.**
  `apps/desktop-support` is a **SECOND Electron app** (`@connect/desktop-support`, appId
  `com.connectcommunications.supporttools`, productName "Loopcom Support") holding
  `remoteSupport/lanScan.ts` (sweep the local /24 on 80/443, then parse Windows `arp -a`),
  `inputInjector.ts` and `mainWiring.ts`. **The code is good and it is in the wrong app** —
  the plan is to LIFT it into `apps/desktop` and retire the support app, never to ship a
  second installer or a Windows service.
- ⛔ **`/lan-phones/*` is live and has NEVER been called.** The api routes and the
  `/admin/lan-phones` screen both exist; `LanDiscoveryRun` has **zero rows**, because the
  client that was meant to call them was never shipped.
- ✅ **What must NOT be rebuilt:** the provisioning writer (`consoleSavePhone` → helper →
  **VitalPBX's own PHP generator**, proven on production and past the 20-phone licence cap);
  **379 handset photos** on the PBX at `provisioning/public/images/<brand>/<MODEL>.png`
  (**81 Yealink** — the filename IS `phone_models.model` uppercased, so a discovered model
  maps straight to its picture with no lookup table); **427 models**; **82 Yealink vendor
  templates**; `POST /internal/pbx/contact-status` (**the only thing that may turn a phone
  green**); the shipped `yealink-check-cfg` NOTIFY; and remote support's polled
  `/pending` pattern for admin→customer commands (**no new socket, no new push channel**).
- ⛔⛔ **THE ARCHITECTURAL WIN: a phone ALREADY REGISTERED TO US can be reset, rebooted and
  re-provisioned ENTIRELY FROM THE PBX over SIP** — `sip.notify_reset.enable = 1` in the
  template plus `pjsip send notify yealink-reset endpoint <ep>` (`Event: reset`, firmware
  ≥ 81). **No office access, no admin password, nothing installed.** The LAN path is needed
  only for a phone that still belongs to the previous provider and has never spoken to us.
- ⛔ **Yealink RPS is out of bounds.** A reset phone asks Yealink's redirection service and
  goes to whoever claims that MAC; release is a request the losing provider or Yealink
  processes. **Detect it, stop after 2 attempts, hand to support — never try to defeat it,
  and never reset a phone in a loop.** (The old RPS was discontinued 2025-10-01.)
- ⛔⛔ **TWO LIVE FAULTS FOUND, NEITHER FIXED.** (1) **A customer's phone is set to the
  Marshall Islands** — `provisioning.templates` id **21 "BV 106"** reads
  `timezone = -12|Eniwetok,Kwajalein` while every other template is Eastern, so that handset
  has shown a time **17 hours out** and nobody reported it. ⛔ The fleet holds **five**
  distinct timezone values and four `time_format` values. Izzy's standing instruction now:
  **New York and 12-hour on every phone, always**, with `summer_time = 2` (Yealink's
  automatic DST), backlight always on, voicemail `*97`. (2) **Editing a phone silently
  erases every BLF on it** — `scripts/pbx/mirror/console_writes.py::save_phone` writes
  `` `keys` `` **only in the INSERT branch**, and `pbxConsoleRoutes.ts` never passes `keys`
  at all, so an edit blanks the button layout at the next render with no error anywhere.
- ⛔ **BLF/speed dials live in `provisioning.devices.keys` as JSON** —
  `{"dss_keys":{"1":{"type":"16","description":"Leah Fulop","value":"101","extension":"101","line":"1"}}}`
  (**type 16 = BLF, 15 = Line**, `tpl_override:"1"` beats the template). Izzy's rule: **a BLF
  for every extension EXCEPT the phone's own**, remaining keys free for customer speed dials.
  ⛔ Key counts are per model (T54W 1–27, T42S 1–15, T23G 1–3) — trim and say so.
- ⛔ **A model with no `provisioning.templates` row is the normal case** (53 rows vs 427
  models). Izzy: the agent **writes the profile itself** from the vendor `template.cfg`
  already on the PBX, applies the house standards, renders, and verifies before any handset
  is pointed at it.
- ⛔ **Verifying a mockup's contrast: composite alpha AND handle `color(srgb …)` floats.**
  Chrome returns `color-mix()` as `color(srgb 0.89 0.92 0.98)`; a naive `match(/[\d.]+/g)`
  reads 0.89 as an 8-bit channel and reports near-black. That produced two rounds of false
  failures. ✅ Once fixed: **1,145 text elements swept in BOTH themes, all pass AA** — and it
  caught three real defects, incl. that **a `<button>` does not inherit `color`**, so the
  choice-tile text fell back to the UA default and would have been invisible in dark mode.
- ✅✅ **APPROVED AND BUILT THE SAME DAY (Izzy: "other than that, you're good to go").**
  Four layers: the rules in **`packages/shared/src/deskPhoneSetup/`** (standards, button
  layout, state machine, device identity, escalation ladder — all pure); the hands in
  **`apps/desktop/src/phoneSetup/`**; the head in **`apps/api/src/deskPhoneSetup/`**; the
  screen in **`apps/portal/components/deskPhones/`** at **Settings → Devices → Desk Phones**.
  Commits `761d1055` → `1d16d2db` on `feat/ivr-migration-takeover`.
  Mockup-vs-built proof: <https://claude.ai/code/artifact/93ca11e8-9c27-40c7-827f-21d648a9d8cc>
- ⛔⛔ **THE SECURITY BOUNDARY, IN ONE SENTENCE: the desktop app can express exactly FIVE
  named operations** — `discover`, `fingerprint`, `test_credentials`, `reboot`,
  `trigger_autop` — **each against a private office address it re-validates itself.**
  There is no URL parameter, no host parameter and no command, and **factory reset is
  deliberately NOT a local capability**. Credentials are passed **by reference** and
  resolved behind the OS keystore, so a password never crosses the IPC boundary in either
  direction. ⛔ Rate limits sit on the CUSTOMER's machine as well as the server, because
  the server is the thing that might be compromised.
- ⛔⛔ **`decideReset()` IS THE ONE FUNCTION THAT MUST NOT BE WRONG.** Pure, reads the
  STORED row rather than anything in memory, fails closed on all five branches, and is
  re-checked by the route immediately before a reset is issued. **Proven: twenty
  concurrent advance calls on one authorised phone reset it exactly once**, and a fresh
  process (app closed, Windows restarted) refuses a second reset. Authorisation lives on
  the RUN, names the exact phones, and **an admin who SENT the request cannot supply it**.
- ⛔ **Ready is only ever claimed because Asterisk said so** — and a PBX throw resolves to
  false, so unknown is never optimistic. Accepting settings is not working.
- ✅ **The BLF bug from the investigation IS FIXED** (`console_writes.py::save_phone` can
  now write the button columns on an edit, and writes only the ones the caller supplied —
  writing them unconditionally is the same bug wearing a different hat). Installer copy
  re-synced; both guards fail against `HEAD`.
- ✅ **Proven as: shared 537/537 · desktop 77/77 · api desk-phones 72/72 (27 route + 32
  stress + 6 chaos + 7 ordering guards) · portal 299/301 (the two documented pre-existing).** Typecheck: shared, desktop
  and portal 0; **api adds 0 errors in any file touched** (its total reads 76 vs the
  75 baseline because of another session's in-flight `server.ts` work, verified line by
  line). ⛔ The stress test covers every scenario Izzy listed, incl. a phone that changes
  address after a reset, an RPS redirect, a router override, 20 phones with one broken,
  15 identical handsets, a forged tenant, a cross-customer read and a device trying to
  inject control characters into a diagnostics line.
- ✅✅ **DEPLOYED AND CONTAINER-VERIFIED 2026-08-21.** Migration
  `20260821200000_desk_phone_setup` applied **23:51:16Z** — both tables present
  (`DeskPhoneSetupRun` 15 columns, `DeskPhoneSetupPhone` 23) and **0 rows, so the feature
  is inert and nothing changed for any customer**; routes, the permission rule and the
  shared rules all grepped inside `app-api-1`; the portal bundle grepped for its own
  strings (`dps-root`, `dps-wz`, "Do you know what kind of phone you have"), never by the
  deploy's exit line; `/settings/desk-phones` answers **200 on both hostnames**, 0
  restarts on either container.
- ⛔⛔ **STRESS-TESTING FOUND TWO REAL DEFECTS THAT REVIEW DID NOT, AND BOTH WERE IN
  THINGS THAT LOOKED FINE.**
  **(1) AN SSRF BYPASS IN THE ADDRESS FENCE.** The private-address check parsed each
  octet with `Number()`, and `Number("010")` is **10** — while the OS resolver reads
  `010` as **octal 8**. So `010.0.0.1` passed our fence as "10.0.0.1, private" and the
  request went to **8.0.0.1, a public host**. Replayed against `HEAD`, **4 of 5 hostile
  addresses got through**. ⛔ The fix is not a better regex: `canonicalPrivateIpv4()`
  refuses any leading-zero octet outright and **the request is rebuilt from the canonical
  parsed form**, so the string that was validated is the string that is dialled. Found by
  fuzzing, not by reading.
  **(2) OWNERSHIP WAS NOT THE FIRST CHECK.** `authorize-reset` answered **400** for an
  empty body and **403** for a missing permission — both **ahead of** the 404 for a run
  that is not yours. Neither is exploitable alone (a nonexistent run answers the same),
  but *"another customer's run is indistinguishable from one that never existed"* is the
  property that is simple to hold forever, and it only holds if ownership dominates.
  Every run-scoped route now does **`ownRun()` → permission → body**, and
  `mayAuthorizeReset()` is **deleted rather than left unused** — it checked a permission
  before ownership by construction, and a dead helper with a security-shaped name is an
  invitation to put the bug back. ⛔ The `/admin/` routes are deliberately cross-tenant
  and are held to the stricter rule instead: staff-gated before they read anything.
- ⛔⛔ **THE RULE BOTH OF THOSE EARNED: A GREEN SUITE PROVES THE CASES SOMEBODY THOUGHT
  OF. RANDOMISED AND EXHAUSTIVE DRIVING PROVES THE ONES NOBODY DID.**
  `deskPhoneInvariants.test.ts` walks **all 8,192 phone conditions × 384 records** and
  proves no unauthorised reset, no second reset, nothing disruptive during a call, nothing
  past the attempt cap, every action inside the closed list and no jargon in any customer
  message. `deskPhoneChaos.test.ts` drives the **real routes** through 300 seeded random
  runs × 40 steps (plus a 500-step run, interleaved authorise/advance, 25 concurrent
  operations on one phone, every malformed body against every route and hostile ids) and
  re-checks every invariant **after every single step** — 12,000+ operations. The seed is
  printed with any failure, so a chaos failure is reproducible.
  ⛔ **`deskPhoneRouteOrder.test.ts` reads the route file's SOURCE**, because a line
  ORDER is invisible to a behavioural test of any one call and inexpressible as a type;
  **4 of its 7 tests fail replayed against `HEAD`**.
- ✅ **THE ORDERING FIX IS PROVEN LIVE ON PRODUCTION, not just by test** — a read-only
  probe against the running container, every call aimed at a run id that does not exist:
  **all eleven answer 404**, including the three that used to answer 400, and hostile ids
  (traversal, quote-injection, 300 chars) too; `GET /desk-phones/state` answers
  **200 `hasActiveRun: false`**, which is the live confirmation that the feature is inert.
  ⛔⛔ **A nuance to know before reading a 403 here: there are TWO gates and the outer one
  fires first.** A real TENANT_ADMIN gets **403 on every one of those paths** from the
  global `PORTAL_API_PERMISSION_RULES` prefix entry, before the route body runs at all.
  That is **uniform for every run id, so it is not an oracle** — and it answers a different
  question from the in-handler order. *May you be here at all* (the prefix gate, 403) and
  *is this yours* (`ownRun`, 404). ⛔ **Do not "fix" that 403 by moving the prefix gate**
  — it is what keeps an unprivileged caller off this surface entirely.
- ⛔ **No PBX write was made, so the Marshall Islands template (id 21, 17 hours out) and
  the manual-DST template (id 3) are still wrong on production** — that needs Izzy's
  mandate. ⏳ Also unbuilt on purpose: the `reset_over_sip` executor, the
  `templates.provision` generation path (designed, unexercised — verifying it needs a
  throwaway phone row on prod), and firmware update/recovery.
- ⛔⛔ **A SECOND FULL PASS (2026-08-22, Izzy's ask) FOUND FIVE MORE, and the headline
  is the biggest gap of the whole build: THE WIZARD NEVER DROVE THE SETUP.** The api's
  `advance` decided, the desktop could perform, and nothing connected them — the live
  step only polled, so "Set Up My Phones" would have sat on "Setting up your office"
  forever, with every suite green (the stress tests drove `advance` themselves).
  ✅ `apps/portal/components/deskPhones/setupDriver.ts` is the loop now: per tick it asks
  the server per phone, performs what this machine can perform, records what it
  observed, reports back. The server stays the only decider; a non-executable
  instruction is never hammered (3-stall cap); a failing phone does not stop siblings.
  ⛔ The live copy changed to **"keep this window open while we work"** — the office
  machine does the work, so "you can close this" would quietly stop a setup.
- ⛔⛔ **THE TWO PERSON-ONLY MOMENTS HAD NO SCREEN** — `resetAuth` sat in the Step type
  unrendered. Now: ONE approval card per batch of phones needing clearing (ten dialogs
  teaches clicking through), and a password card per locked phone whose password goes
  into the desktop's protected store BY REFERENCE — "never sent to Loopcom", and a
  guard asserts the driver has no `password:` key anywhere.
- ⛔⛔ **A PRINTER FLEET COULD BECOME A PHONE LIST.** `scanLan` returns every ARP entry
  and the wizard submitted all of it — 4 phones + 19 other devices read "We found 23
  desk phones". `discoveryFilter.ts`: a phone only on EVIDENCE (fingerprint or a
  phone-maker hardware block — which still shows a locked phone); the rest are counted
  for the honesty line and never submitted; `shouldFingerprint` bounds probe spend.
- ⛔⛔ **THE RESET ISSUE WAS CHECK-THEN-ACT.** Two concurrent advances both read
  resetCount=0 and both issued a wipe — invisible to the chaos suite because awaits
  march handlers in lockstep under the microtask queue. With one tick of modelled
  database latency, **the pre-fix route issued FIFTEEN wipes from fifteen concurrent
  advances**; the fixed route issues one. The claim is an `updateMany` guarded on the
  values read, and the test counts AUDITED issuances, not the counter — both racers
  wrote 1, which is exactly how it hid. ⛔ Fake-db reads return SNAPSHOT COPIES now;
  a fake handing back the live shared row masks every race of this shape.
- ⛔ **Three smaller:** `applyYealinkStandards` rewrote only the FIRST occurrence of a
  duplicated key (Yealink is last-value-wins — the vendor's later line kept winning);
  the adapter's fence throw was caught by the transport try and mislabeled a refusal
  as retryable "unreachable"; the "Connecting" pill measured 4.42/3.87 as 11px text —
  ink per theme now, 6.00/6.08, and the full sweep reads 40/40 AA both themes.
- ⛔⛔ **IZZY'S FEEDBACK ROUND (2026-08-22) WIDENED THE SCOPE: ANY VOIP DEVICE.**
  `packages/shared/src/deskPhoneSetup/deviceKinds.ts` — desk phones, **Grandstream HT
  boxes**, **Yealink W-series cordless bases**, **Fanvil PA speakers**, **door
  intercoms** (GDS, Fanvil i-series). ⛔ The KIND decides three things and nothing else
  may branch on a model string: what the customer is told it is ("Small box your regular
  phones plug into", never "ATA"); which house rules apply; whether the office machine
  may drive it locally. ⛔⛔ **The Grandstream HT rule is Izzy's, verbatim: accept
  incoming calls ONLY from the SIP server it is registered to, always Eastern time** —
  and a doorbell or ceiling speaker gets the SAME inbound lock, because a device that
  opens a door must never take instructions from anything but our server. ⛔ **The
  vendor config codes are deliberately NOT in the repo** — a wrong Grandstream P-code
  silently configures nothing; capture them off a real device before the template
  writer ships. ⛔ **Only Yealink is driven locally** (`vendorSupportsLocalActions`);
  other vendors are configured server-side and the driver waits. Discovery knows the
  Grandstream/Fanvil IEEE hardware blocks and banners now, so an HT on a shelf is shown
  rather than filtered. **Only desk phones ever get BLF layouts.** ⛔ Clearing covers
  every kind by construction — `decideReset` takes the RECORD and the record has no
  kind field.
- ⛔⛔ **THE TWO QUESTIONS BECAME FULL PAGES** (Izzy: "it took me a second to realize
  how it's working… dumb people will just get stuck here", "they should be able to
  select which one should be cleared", "what if they don't know their password?").
  The wizard STOPS when a decision is needed. Clearing: one question fills the screen,
  **a checkbox per device** (ticked by default), the button counts the ticked ones,
  "Skip all of these for now" is real, and **an unticked device is a recorded
  deliberate no** (`resetDeclined`) — never re-asked, never wiped, proven exhaustively.
  Password: **"I don't know it" is a big button and a complete answer**
  (`passwordUnavailable`) — that device hands off to Support kindly while the rest keep
  going; proven exhaustively that it is never asked again. Both new booleans widened
  the exhaustive space to **2^15 × 384 = 12.6M decisions per invariant.**
- ✅ **Screens improved on the same pass:** "Do you know what kind of phone" now TAKES
  the answer (the copy promised "tell us" and never asked) and echoes it on the found
  screen; the connection answer now shapes the nothing-found explanation. Comparison
  with the shipped stylesheet:
  <https://claude.ai/code/artifact/7632e24e-4526-45ca-a6f1-4d412785529d>. Totals after:
  shared **549** · desktop **77** · api desk-phones **72** · portal **316/318**.
- ✅✅ **DESKTOP 0.1.14 (2026-08-23): THE BLANK "PAPER" TASKBAR ICON WAS A
  RENAME-ORPHAN SHORTCUT, NOT AN ICON PROBLEM AT ALL.** ⛔⛔ Windows resolves a
  running window's taskbar-BUTTON icon from the Start Menu shortcut matching the
  window's AppUserModelID — NOT from the window's own HICON. Izzy's machine had a
  stale **`Electron.lnk`** carrying `com.connectcommunications.desktop` but pointing
  at the **deleted `Connect.exe`** (dead target → generic document/paper icon). That
  is why every layer verified perfect — exe embed valid (`ExtractAssociatedIcon`
  returns blue), every `.ico` frame 97-100% opaque, live window HICONs non-zero, AUMID
  matching — and the taskbar STILL drew paper: Windows was reading a dead shortcut, not
  the window. ⛔ **THE DIAGNOSIS THAT FOUND IT: enumerate every `.lnk` under Start Menu
  / Quick Launch / Desktop whose `System.AppUserModel.ID` equals the app's AUMID, and
  check each target exists** (`findaumid.ps1` pattern). ⛔ **A blank Windows taskbar
  icon on an app with a valid embedded icon is an AUMID→shortcut problem — check the
  shortcuts BEFORE the icon pipeline.** Fixed fleet-wide in `build/installer.nsh` (⛔
  force-added — `apps/desktop/build` is gitignored; auto-included by electron-builder)
  which deletes the orphan `Electron.lnk`/`Connect.lnk` on every install. ⛔ **GDI
  screen capture CANNOT see the Win11 taskbar** (separate DWM composition layer) — it
  captures the windows/desktop beneath, so this cannot be eyeballed remotely; the
  shortcut enumeration IS the diagnosis. ⛔ Also: clearing Explorer's `iconcache*` +
  `thumbcache*` must be done with the app CLOSED (a held handle defeats a live clear),
  and 0.1.13's `pinWindowIcon` re-assert ladder (120/400/1200ms after first show)
  covers the separate late-taskbar-button timing race.
- ✅✅ **DESKTOP 0.1.13 IS THE PUBLISHED BUILD (2026-08-23) — two live-found icon
  fixes on top of 0.1.11.** (1) **THE TASKBAR FOLLOWS THE *SYSTEM* THEME, NOT THE APP
  THEME.** Izzy runs Windows split mode (system/taskbar DARK, apps LIGHT); the taskbar
  sits on the SYSTEM surface but `nativeTheme.shouldUseDarkColors` reports the APPS
  value, so 0.1.11 showed light-blue on a dark taskbar. `themeIcon.ts::resolveDark()`
  reads `SystemUsesLightTheme` from the registry (0 = dark), falls back to nativeTheme
  only on a failed read, and re-checks on a 15s poll because **Windows fires NO event
  when only the system half of a custom theme changes**. Proven live on his exact
  config: apps light + system dark → navy at boot; flip system → light-blue within the
  poll. (2) **THE BLANK "PAPER" TASKBAR ICON WAS A TIMING RACE, NOT A BAD ICON.** Every
  artifact was correct — exe icon valid (`ExtractAssociatedIcon` returns blue), every
  `.ico` frame 97-100% opaque, AUMID matched, the live window reported valid HICONs
  (`WM_GETICON` non-zero) — yet the taskbar drew the generic document icon. **The
  taskbar BUTTON is created a beat AFTER the window first paints, and a `setIcon` that
  lands before the button exists is silently dropped.** `pinWindowIcon` now re-asserts
  on a **120/400/1200ms ladder after the first show**. ⛔ When a Windows taskbar icon
  is blank, check the icon LAST — verify the exe embed, the frames' opacity and the
  live HICONs first; if those are good it is a cache or a timing issue, never the art.
  ⛔ A stale Explorer icon cache also masked it — clear `iconcache*` AND `thumbcache*`
  with the app CLOSED (a held handle defeats a live clear).
- ✅✅ **DESKTOP 0.1.11 IS THE PUBLISHED BUILD (2026-08-23): THE ICON FOLLOWS THE OS
  THEME.** Izzy's mapping verbatim — **dark mode → navy-2a, light mode → blue-2b** —
  in `src/themeIcon.ts`: a `nativeTheme "updated"` watcher re-images the tray and
  every window the instant the Windows toggle moves. ⛔ The EXE-embedded icon (Start
  menu, pins, toast header) cannot follow a theme — one .ico per program — and stays
  blue-2b. ⛔ `iconPath` is a per-call resolver now; a guard pins that it never goes
  back to module-load resolution (that shape makes the swap a lie), and another pins
  that every size of BOTH variants exists (a missing file = an EMPTY nativeImage = a
  silent no-op). ✅ **Proven LIVE on Izzy's own machine**: a throwaway harness ran the
  compiled module while the real `AppsUseLightTheme` registry value was flipped 4× —
  every swap **within ~95 ms**, artwork proven by its own pixels (light RGB 37,117,255
  vs navy RGB 11,16,32), theme restored after.
- ✅ *(superseded by 0.1.11)* **DESKTOP 0.1.10 (2026-08-23)** — the wizard's hands
  (phoneSetup IPC + capability fence, verified inside the packed asar), the /22
  scanner fix, and **the designer's own per-size Windows frames** (Izzy's second kit,
  2026-08-23: loopcom-win-16/32/48/64/256 with rounded corners and real transparency,
  shipped VERBATIM, diff 0; only 24/128 synthesised, no sharpening — ⛔ when a designer
  delivers per-size frames, use them per size; no downsample of a 1024 tile competes
  with a frame drawn at 16px).
  `verify:icon` read the BUILT exe: **7 RT_ICONs byte-identical to icon.ico, nothing
  else embedded**. `latest.yml` answers 0.1.8 on both hostnames; installs ≥0.1.4
  auto-update within ~3h — ⛔ **each update renames Connect → Loopcom with the new
  icon**; a customer whose "app vanished" should look for the blue tile. ⛔ The
  toast keeps NO image — the kit's toast PNGs are pinned in the brand folder and
  deliberately unwired. ⛔ The winCodeSign cache dir had vanished; recreated per the
  rebrand handoff §2.
- ✅ **THE SIDEBAR DOOR: `workspace.desk_phones` → /settings/desk-phones, permission
  `can_setup_desk_phones`** — the SAME key the page and api gate on. In no default
  bucket → only SUPER_ADMIN sees it today; an ACTION key → custom roles offer it; the
  nav entry makes it appear in /admin/permissions. ⛔ NO hardcoded visibility rule (a
  guard pins the absence). ⛔ Placed ABOVE Conference — the Conference guard correctly
  refused the slot between Conference and Install, which is Izzy's exact recorded
  2026-08-20 placement. Two recorded instructions collided; the exact pin won.
- ✅✅ **A REAL CUSTOMER HOLDS THE KEY NOW — A plus center ext 103, 2026-08-25
  (Izzy: "permission to add desk phones, and add it to his sidebar"). Handoff §13.
  Permission change only: no code, no deploy, no migration, no PBX write.**
  Jacob Weinstock (`jacobw@apluscenterinc.org`, user `cmnmjhjgs002vp96hstcfzhnw`,
  tenant `cmnlgnumi0000p9g6l7t1t0z7`) is the first non-SUPER_ADMIN with
  `can_setup_desk_phones`. ⛔ That is the **real April** A plus center — the
  2026-08-18 duplicate was renamed **TYH Industries**; check the id, not the name.
- ⛔⛔ **THE TRAP THAT ALMOST GAVE IT TO TWO OTHER COMPANIES: his existing custom
  role "S m Weiss" (`cmq9mt87n039rrw13ay3d13gr`, 76 keys) is assigned to THREE
  users in THREE unrelated tenants** — Relax Tires, Create A Box and A plus
  center. Custom roles live under `connect-admin-tenant-v1` and are assigned
  platform-wide by `userId`, so "their role" is routinely not theirs.
  **Run `GET /admin/custom-roles/:id/users` before editing ANY custom role.**
- ✅ **The fix is an ADDITIVE SECOND ROLE, because roles UNION.**
  `getEffectiveCustomRolePermissions` (`platformRolePermissions.ts:214`) looks
  assignments up by `userId` alone and unions every ACTIVE role — so role
  `cmt8ulg430abbpn13k5fai5x7` carrying the single key was assigned alongside the
  shared one: **76 → 77 keys, `GAINED: ["can_setup_desk_phones"]`, `LOST: []`**,
  and both other holders re-read afterwards **unchanged**.
  ⛔ The "rebuild their full effective set + the addition" recipe in
  [[custom-roles-are-authoritative]] is only for a user with **NO** custom role,
  where the role replaces the bucket — applying it here would have forked him off
  the shared role forever.
  ⛔ `PUT /admin/users/:userId/custom-roles` is **REPLACE**: it deletes every
  assignment under the actor's tenant first, so the body must carry the EXISTING
  role ids too or the person loses their whole portal. ⛔ `POST
  /admin/custom-roles` returns the row under **`role`**, not `customRole`.
- ⛔ **`can_authorize_phone_reset` was deliberately NOT granted.** The two-key
  split above is the point — the wizard points phones at us, a reset **ERASES a
  customer device**, and Izzy asked to *add* phones. A handset still owned by the
  previous provider will need clearing; that is a separate decision.
- ✅ **The sidebar needed no code change**: `workspace.desk_phones` has **no
  SUPER_ADMIN force line** in `isNavItemVisibleForUser`, so visibility is exactly
  `can_view_section_workspace && can_setup_desk_phones` and he already held the
  section key. ⛔ Judge it from **`/me` → `portalPermissionSet`**, not
  `permissions` — probing the wrong field reported 0 keys and read like a failed
  grant. **Proven live both ways:** Jacob `GET /desk-phones/state` → **200**;
  his colleague Leah (ext 101, same tenant) → **403 `permission:
  can_setup_desk_phones`**, her set unchanged at 42 — the grant is scoped to the
  PERSON, not the company.
- ✅✅ **HE OPENED IT THE SAME HOUR AND THE FIRST LIVE RUN FILED THREE REPORTS —
  ALL FIXED IN `42f0c2d3` (2026-08-25, api + portal; handoff §14).** Izzy, at the
  office on ext 103's login: found 6 devices, "I know I have more phones than
  … six", "not telling me the names", "mac addresses should all be displayed."
- ⛔⛔ **THE VENDOR EVIDENCE WAS THROWN AWAY AT INGEST.** All six stored vendor
  "unknown" while their MAC blocks had ALREADY identified them (5 Fanvil room/
  door units + ext 102's Yealink T42S) — the very evidence the discovery filter
  admitted them on; the stored vendor came only from the locked web page's
  fingerprint. The ingest now falls back to `guessVendorFromMac` — at the
  SERVER, so both submit paths get it.
- ⛔⛔ **`listPbxProvisionedPhones` HAD NEVER RETURNED A ROW IN ITS LIFE** — it
  selected **`pm.name`**, a column `provisioning.phone_models` does not have
  (it is `pm.model`), so EVERY call threw "Unknown column", was caught, and
  reported the whole PBX as unreachable. Invisible because its only caller (the
  lan-phones screen) has never been used. **A helper with no real consumer has
  never been proven — its first customer is its first test.** Fixed +
  source-guarded (comment-stripped; **guard fails replayed against HEAD**), and
  extended with the accounts→extension join so a MAC resolves to the person.
- ✅ **The wizard NAMES phones from the PBX's own provisioning records now**:
  ingest joins MAC → record, fills model/vendor, and where the record maps to a
  Connect Extension writes the SAME `{extensionId, extNumber, displayName}` a
  human's assign click writes — ⛔ never over a human's assignment
  (`!row.extensionId && !row.extNumber`, tested). Injectable as
  `deps.provisionedPhones`; best-effort everywhere — a PBX that cannot be read
  costs the names, never the discovery. ✅ The join replayed read-only on the
  live PBX resolves all 9 A plus devices to people (102 → Mrs Weinstock…).
- ⛔ **"More phones than six" is a VLAN fact, not a scanner bug**: ~13 A plus
  SIP devices register from the office IP while the 192.168.0.0/24 sweep saw one
  provisioned Yealink — the rest sit on a separate phone network the PC cannot
  ARP into. ⛔ Do NOT "fix" by scanning arbitrary subnets (the capability fence
  is deliberate; cross-subnet ARP is impossible anyway). Shipped instead:
  `knownElsewhere` on the /discovered response — the provisioned phones the scan
  did not see, listed on the found screen as "already set up … different network
  in the building". ⛔ Context only; an unseen record never becomes a phone row.
- ⛔ **THE CUSTOMER VIEW CARRIES THE FORMATTED MAC ON PURPOSE NOW** (Izzy, live:
  "mac addresses should all be displayed" — it is the sticker under the
  handset). The chaos guard that FORBADE it asserts the opposite now (present
  AND formatted); ip/state/provisioningUrl stay diagnostic-only. ⛔ `formatMac`
  UPPER-cases — a lowercase regex in the flipped guard failed the first run.
- ⛔⛔ **THE SECOND LIVE ROUND PROVED THE SCANNER ITSELF LOSSY, AND IZZY CALLED
  IT (2026-08-25, `beff0fe4` + `4bc1c3b0`): "they are definitely on the same
  network — if your scanner doesn't pick it up, the scanner is not working
  properly."** His rescan re-saw only 2 of the 6 devices the first pass found.
  Three structural faults in `lanScan.ts`: web-ports-only (a provisioned phone
  with its web pages off answers neither), a 400 ms teardown that can abandon
  the PENDING ARP resolution before a slow device answers, and ONE end-of-sweep
  `arp -a` read while entries age out. **Rebuilt:** 80/443/5060 in PARALLEL at
  900 ms, a 1.5 s retry pass over addresses missing from the table, the table
  read + MERGED after every pass.
- ⛔⛔ **AND `beff0fe4` FIRST: `Number("T2")` — the name join returned NOTHING
  because `TenantPbxLink.pbxTenantCode` is "T2", not "2".** The one-liner came
  from `lanPhoneRoutes.ts`, where its failure direction was WORSE: the NaN
  fallthrough dropped the tenant filter and compared against EVERY tenant's
  phones. One exported parser now (`resolvePbxTenantNumber`, tested on the live
  row shapes); lan-phones REFUSES instead of widening. Same commit: the
  enrichment OUI-fills vendor on every row of the run (not only rows the
  current pass resubmitted), and **`PBX_PHONE_IMAGE_BASE` was never set in
  production** — the photo proxy answered not_configured on every call, ever.
  Set to `https://m.connectcomunications.com/provisioning_resources` (proven:
  200, real PNG, strict TLS; backup `.bak.*.phonephotos`).
- ✅ **The device names ITSELF over SIP now (`4bc1c3b0`, desktop 0.1.15):** a
  locked web page fingerprints as "unknown", but one read-only SIP OPTIONS gets
  back `Fanvil i16SV 2.4.0` / `Yealink SIP-T42S …` — no password, no web page,
  and ANY response counts (a 405 refusal is still signed). `sipProbe.ts`:
  private-address-only, hostile branch seed refused, SIP *requests* arriving at
  our socket never parsed, replies from any other address discarded. The scan
  attaches the identity to every present host; the `fingerprint` op is HTTP
  first / SIP second (an HTTP model is final — a test counts the probe calls);
  ⛔ ONE naming rule — `identityFromBanner` — serves both paths, and
  `shouldFingerprint` treats answering SIP as better evidence than any OUI
  block. ⛔ The wizard KEEPS a scan-provided identity — it used to null it.
- ⛔⛔ **THE RESET TEST FOUND THE FOURTH DEAD DEP: `isRegistered` WAS NEVER
  WIRED (`995dfa50`, handoff §18).** Izzy factory-reset his own ext-103 phone
  and the wizard "still showed the same" — because server.ts never passed the
  optional `isRegistered` dep, so `advance`'s Asterisk question silently
  skipped and `registeredToUs` was ALWAYS false: the wizard could never turn a
  phone green, and a reset phone kept its record identity. ⛔ **An optional dep
  nobody wires is a feature nobody has — grep the server.ts call site before
  believing an injected capability is live.** Fix: `defaultIsRegistered` reads
  the live **`PbxEndpointRegistration`** mirror (contact-status pushes; proven
  truthful against the 502–505 outage), querying the DESK endpoint
  `T<n>_<ext>`, never `_1`. Every customer list now carries `connectedNow`
  beside the record identity — pills read Connected / Not connected / Found,
  and a dark "already set up" entry reads "Not connected right now": **the
  record says whose phone it is; only Asterisk says whether it works.** The
  found footer reads "Choose who uses each phone" — the assignment step
  existed (found → match) and was merely unfindable. ⏳ The true end-to-end
  acceptance — reset T53W → discovered → assigned → REGISTERED — is exactly
  what Izzy is walking now.
- ⛔⛔ **"THE PHOTOS ARE NOT SHOWING" — AN `<img>` SENDS NO TOKEN (`ecf70d93`,
  portal DEPLOYED, handoff §17).** The photo route requires a session; a browser
  image tag carries no Authorization, so every picture request was refused, for
  everyone, always — and ⛔ **the server-side probe that "proved" the photo
  route proved nothing about the browser: it attached the Bearer by hand. A
  media URL is only proven by the tag that will fetch it.** Fix: `?token=` on
  the URL (the recordings player's pattern) + ONE `PhonePhoto` component with a
  real `onError` → glyph fallback (⛔ VitalPBX ships NO Fanvil i-series photos;
  the i64 door correctly keeps the drawing). The old guard pinned the render
  ternary and was structurally blind to this; it now pins the component, the
  fallback, and the token on the URL.
- ⛔⛔ **SUPERSEDED BY 0.1.16 THE SAME EVENING — "there is only one network
  here" WAS RIGHT, and the registrar proved it (`49166657`, PUBLISHED, sha256
  `3b7af6ac…`).** The PBX registrar's `call_id` carries each Yealink's PRIVATE
  address (Grandstream: `x-ast-orig-host`): A plus center's desk phones sit at
  192.168.0.61/.94/.224/.240/… — the exact swept subnet — while every
  table-first scan missed them. ⛔ **Windows throttles the neighbor lookups a
  fast connect burst fires, negative-caches the failures, and `arp -a` then
  OMITS live devices — so a table-first sweep is structurally blind.** 0.1.16:
  SIP OPTIONS to EVERY address (the device answers regardless of the table and
  names itself), ping-pass with Windows' own pacing, neighbor table read via
  BOTH `arp -a` AND `netsh interface ip show neighbors` (Unreachable/Incomplete
  skipped — a failed lookup is not a device), merged after every pass.
  ⛔ **`database show registrar` is the ground truth for a phone's LAN address
  — read it before ANY topology theory.** ⏳ Acceptance: the office's next scan
  finds the ~10 live devices with models. Separately REAL: rooms 502–505 down
  since 12:30 ET (building switch/PoE) — no scanner finds hardware off the wire.
- ✅✅ **Desktop 0.1.15 is PUBLISHED (Izzy: "Publish it.", 2026-08-25)** — latest.yml reads 0.1.15 on both hostnames, sha256-verified alias; fleet auto-updates. **Was:** (installer +
  icon guard OK, the probe grepped in the packed asar) — publishing
  auto-updates the fleet and waits for Izzy's word, and the scanner lives in
  the INSTALLED app, so the office only gets the new sweep after publish + the
  in-app "New Update — Install" click. Proven: desktop 99, shared 95, api
  suites 90, typechecks at baseline.
- ⏳ **NOT PROVEN: nobody has pressed "Search again" on the new build.**
  Acceptance: Izzy rescans at A plus — the Yealink reads "Mrs Weinstock — ext
  102" with photo + MAC, the Fanvils read fanvil + MAC, and the "also set up"
  section lists the ~8 unseen phones by name. ⛔ Close and reopen the desktop
  app first — an open window keeps the old bundle.
- ⏳ **Still not proven by a human: he has not opened it** (last login
  2026-06-17). ⛔ **He must use the Loopcom DESKTOP app, not a browser tab** —
  the LAN scan runs on his own machine over the desktop `phoneSetup` IPC (≥ 0.1.9
  for the /22 fix). A browser loads the page, says "Open this in the Loopcom app
  on a computer in the same office as your phones", and finds nothing; that is
  correct, not a broken grant.
- ⏳ **NOT PROVEN: nobody has opened the screen and no phone has been set up** — but
  the desktop blocker is gone, so **the acceptance test is now runnable: one real
  device on one real desk** in the updated app.
- ⛔⛔ **THE FIRST LIVE RUN FAILED (2026-08-23, Izzy's own home) AND TAUGHT TWO
  LESSONS — fixed in `b5272867`, desktop 0.1.9 PUBLISHED, portal deployed.**
  (1) **His LAN is a /22** (192.168.6.x, mask 255.255.252.0 — what eero-class home
  mesh routers hand out BY DEFAULT), and the scanner accepted only /24, so there was
  nothing to sweep. `localScannableSubnets` now takes /22–/24 aligned to the true
  network base (his .6.x machine correctly yields 192.168.4.0/22 — where his router
  actually sits); anything wider is refused in BOTH the chooser and `hostsInSubnet`;
  the ARP filter became a range test (`ipInSubnet`) because startsWith can only
  express a /24. (2) ⛔⛔ **The wizard showed the failed scan as "we found 0 phones".**
  `scanLan` did its half — `outcome:"failed"` plus a plain-words note — and the wizard
  dropped both and submitted an empty list. **A failed scan must never read as an
  empty office**: the wizard now shows the scanner's own note and lands back on the
  network step; a guard fails against the pre-fix tree. ⛔ Diagnosis recipe that
  found it: `DeskPhoneSetupRun` rows + the `POST …/discovered` byte size in nginx
  (73 bytes = empty list) + `ipconfig`/`arp -a` on the reporting machine.
  ⛔ Also learned: his SUPER_ADMIN login's tenant (connect-admin-tenant-v1) has NO
  extensions, so on that login the wizard can find phones but has nobody to assign —
  a true end-to-end run needs a login on a real tenant holding the permission.
- ⛔ **Backslash escapes do NOT survive this shell's heredocs** — `
`, `
` and `\u202e`
  were each silently turned into real characters while writing these tests, producing
  unterminated regexes and string literals four separate times. Use python **raw strings**
  or `String.fromCharCode`. And a contrast probe must composite alpha **and** parse
  `color(srgb …)` floats, or `color-mix()` reads as near-black and invents failures.
