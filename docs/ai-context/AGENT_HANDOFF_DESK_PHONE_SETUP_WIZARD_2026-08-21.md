# AGENT HANDOFF — Zero-touch desk phone setup: investigation + architecture + mockups (2026-08-21)

**STATE: INVESTIGATION AND MOCKUPS ONLY. No code written, no deploy, no migration, no
PBX write, no env change, no tenant row touched.** Every PBX interaction in this pass was a
read-only SELECT or a file copy off the PBX. Izzy's instruction: build the whole thing end
to end without stopping between phases, **stopping only for approval of the mockups**.

Mockups (23 screens, both themes, animated, real handset photos):
<https://claude.ai/code/artifact/7a561ef4-9624-4afa-ad19-d59ad9ae4252>

---

## 1. The premise correction that changes the plan

Izzy's brief opens *"Connect already has … an existing local Connect Agent installed with
the application … an agent with access to the local environment."* **That is not true, and
the whole architecture depends on it.**

- ⛔⛔ **`apps/desktop` (the shipped Loopcom app) has NO local agent and NO network
  capability.** `preload.ts` exposes exactly four namespaces — `window`, `phone` (the SIP
  engine), `notifications`, `updates`. `main.ts` registers 12 `ipcMain` handlers, all
  window/update/phone-engine. There is no command channel, no LAN access, no shell.
- ⛔ **"The agent" in this repo is `apps/agent`** — the AI assistant **container on
  loopcom, in France**. It has no route into a customer's office and never will.
- ⛔⛔ **A working LAN scanner DOES exist — in `apps/desktop-support`, a SECOND Electron
  app (`@connect/desktop-support`, appId `com.connectcommunications.supporttools`,
  productName "Loopcom Support") that has never been built or shipped.** It holds
  `remoteSupport/lanScan.ts` (sweep the local /24 on ports 80/443, then parse Windows
  `arp -a`), `inputInjector.ts` and `mainWiring.ts`. **The code is good and it is in the
  wrong app.**
- ⛔ **`/lan-phones/*` is live on the api with an admin screen** (`apps/api/src/lanPhoneRoutes.ts`,
  `apps/portal/app/(platform)/admin/lan-phones/page.tsx`) and **has never been called**,
  because its client was never shipped. `LanDiscoveryRun` has zero rows.

**Therefore: the work is to LIFT the scanner into `apps/desktop` behind a new permissioned
IPC channel and retire the unshipped support app — not to write a new agent or service.**
That satisfies Izzy's "do not create another Windows service or another agent" exactly.

---

## 2. What already exists and must NOT be rebuilt

| Capability | Where | Note |
|---|---|---|
| Provisioning row write + render | `consoleSavePhone` / `consoleRenderPhone` / `consoleDeletePhone` → helper `/console/phone-save` → `scripts/pbx/mirror/console_writes.py` → **VitalPBX's own PHP generator** | Proven on production 2026-08-19 (185,209-byte config served like a handset). Beats the 20-phone licence cap. |
| Handset photos | `/var/lib/vitalpbx/provisioning/public/images/<brand>/<MODEL>.png` on the PBX | **379 files, 20 brands, 81 Yealink.** Filename **is** `phone_models.model` uppercased — direct map, no lookup table. |
| Model catalog | `provisioning.phone_models` | **427 models**, 20 brands. |
| Vendor config templates | `/var/lib/vitalpbx/provisioning/base_templates/<brand>/<model>/template.cfg` | **82 Yealink dirs**; Laravel Blade, ~99 KB for a T54W. |
| Loopcom settings profiles | `provisioning.templates` | **53 rows** — this is the thing most models do NOT have. See §5. |
| Live registration truth | `POST /internal/pbx/contact-status` (telephony `RegistrationStatusNotifier` → api) | **The only thing that may turn a phone green.** |
| Reboot / re-provision | `pjsip_notify__10-default.conf` → `yealink-check-cfg` (already on the PBX) | No LAN access needed for a phone already registered to us. |
| Admin→customer command | `remoteSupportRoutes.ts` + `/remote-support/pending` polling | Reuse the shape; **no new socket, no new push channel.** |
| Tenants/users/extensions | `Extension`, `PbxExtensionLink`, `TenantPbxLink`, `provisioning.devices` | |
| Permissions / audit / secrets | `ACTION_PERMISSION_KEYS`, `AuditLog`, `AgentSecret` | `can_view_lan_phones` and `can_remote_support` already exist. |
| AI with narrow tools | `apps/agent/src/tools/toolRegistry.ts` | Every tool declares `minRole`; `executeTool` **strips any tenant key the model invents**. |

---

## 3. ⛔⛔ TWO LIVE FAULTS FOUND ON THE WAY — both real, both unfixed

**(a) A customer's phone is set to the Marshall Islands.**
`provisioning.templates` id **21, "BV 106"** (B Visible, model 154 = Yealink T53W) has
`timezone = -12|Eniwetok,Kwajalein` while every other Loopcom template is
`-5|United States-Eastern Time`. **That handset has been showing a time 17 hours out.**
Izzy's 2026-08-21 instruction (New York + 12-hour on every phone) closes this class.

⛔ The fleet is inconsistent in general — `select distinct timezone from provisioning.templates`
returns **five** different values: `EST5EDT`, `-5|United States-Eastern Time`, `auto`,
`-12|Eniwetok,Kwajalein`, `16|-18000`. And `time_format` returns `NULL`, `0`, `12Hour`, `1`.

**(b) Editing a phone silently erases every BLF on it.**
`scripts/pbx/mirror/console_writes.py::save_phone` accepts a `keys` argument and writes it
**only in the INSERT branch** — the UPDATE branch does not touch `` `keys` ``. And
`pbxConsoleRoutes.ts` never passes `keys` at all. So any edit through the console blanks
the handset's button layout at the next render, with no error anywhere. **Fixing this is a
prerequisite for the BLF feature.**

---

## 4. Yealink — verified mechanisms (sources in §9)

| Need | Mechanism | Confidence |
|---|---|---|
| Reboot | Action URI `http(s)://user:pass@PHONE/servlet?key=Reboot` | Documented |
| Fetch settings now | Action URI `key=AutoP`; also SIP `check-sync` (already shipped on our PBX) | Documented |
| **Factory reset with no password** | **SIP NOTIFY `Event: reset`**, firmware **≥ 81**, enabled by provisioning **`sip.notify_reset.enable = 1`**. Asterisk: `pjsip send notify yealink-reset endpoint <ep>` | Documented |
| Restrict who may command | `features.action_uri_limit_ip` (comma list; `0` = none, empty = any) and `account.1.sip_trust_ctrl = 1` | Documented |
| Enable/disable Action URI | `features.action_uri.enable` (0/1, **default 1**) | Documented |
| Point at Loopcom | Auto-provision server URL → `https://<pbx>/phoneprov/<tenant-hash>/` (per-tenant 16-hex nginx alias, already exists) | Verified on our PBX |
| Timezone / 12-hour / auto DST | `local_time.time_zone`, `time_zone_name`, `time_format`, **`summer_time = 2` (automatic)** | Read out of our own installed template |
| Backlight always on | `phone_setting.backlight_time` | In our template |
| Voicemail `*97` | `voice_mail.number.N` | In our template |
| BLF + speed dial | `linekey.N.{type,line,value,extension,label}` rendered from `$dssKeys` | In our template **and live on a real customer phone** |

⛔⛔ **THE ARCHITECTURAL WIN: a phone already registered to us can be reset, rebooted and
re-provisioned ENTIRELY FROM THE PBX over SIP — no office access, no admin password,
nothing installed.** The LAN path is only needed for the genuinely hard case: a phone that
still belongs to the previous provider and has never spoken to us.

⛔ **Yealink RPS is out of bounds.** A factory-reset phone contacts Yealink's redirection
service, which sends it to whoever claims that MAC. Release is a request the losing
provider or Yealink processes (`ticket.yealink.com/page/mac-removal.html`). **We detect it,
stop after 2 attempts, and hand to support. We do not attempt to defeat it.** Note the old
RPS was discontinued 2025-10-01; current service is YMCS/RPS.

---

## 5. The DSS key (BLF) format — this is the whole button feature

`provisioning.devices.keys` is JSON:

```json
{"dss_keys":{"1":{"tpl_override":"1","type":"16","description":"Leah Fulop",
 "value":"101","extension":"101","line":"1"}, "2":{...}}}
```

- `type "16"` = BLF, `type "15"` = Line. `description` is the label printed on the phone.
- `tpl_override: "1"` means this key overrides the template's key.
- Live example: device id 3 ("Sarah", A plus center) carries 8 BLF keys today.

**Izzy's rule: every phone gets a BLF for every extension on the system EXCEPT its own,
plus customer-settable speed dials in the remaining keys.** Key counts are per model and
are documented in the template header (`T54W: 1–27`, `T42S: 1–15`, `T23G: 1–3`, …) — the
generator must trim to what the model actually has and say so.

---

## 6. Izzy's decisions captured this session

1. **Wizard is always available** under Settings → Devices → Desk Phones; the prompt card
   disappears once every phone is connected.
2. **Ask "do you know what kind of phone you have?"** — optional, skipped when we already know.
3. **Ask wired vs Wi-Fi with a drawing**, and confirm same-office/same-internet.
4. **Show the PBX photo of each discovered phone**; customer matches phone → extension.
5. **BLF for everyone except yourself**, plus custom speed dials.
6. **Timezone always New York, 12-hour**, automatic DST, backlight always on, voicemail `*97`.
7. **If a model has no settings profile in our system, the agent writes one** for that model.
8. **The agent must do everything in its power to get every phone connected** — an
   escalation ladder (§7), not an unbounded licence.
9. Model preference: Opus or GPT for the reasoning steps.

---

## 7. The escalation ladder (what "never gives up" means concretely)

1 do nothing (already registered) · 2 `check-sync` from the PBX · 3 point at Loopcom + AutoP
· 4 documented default password **once** · 5 ask the customer for the password · 6 factory
reset **with explicit named consent** · 7 reset over SIP instead of HTTP · 8 rediscover by
MAC after the address changes · 9 generate a settings profile for an unknown model ·
10 firmware update (phase two) · **then STOP** — RPS ownership or customer DHCP override,
2 attempts max, hand to support. ⛔ A loop is not persistence.

---

## 8. Verification done on the mockup (not a claim, a measurement)

- 23 screens, 30 handset photos rendering, all three fonts loaded.
- **1,145 text-bearing elements swept for WCAG AA in BOTH themes → ALL PASS.**
- No horizontal overflow at 430 px or 1280 px; notes rail collapses correctly.
- Zero console errors.
- ⛔ **Three real defects were found by measuring rather than by looking:** `<button>` does
  not inherit `color`, so `.tile` text fell back to the UA default (invisible in dark);
  the selected rail icon was 3.57:1; the destructive button was white on `#ef4444` = 3.76:1.
- ⛔ **A contrast probe must composite alpha AND handle `color(srgb …)` floats.** Chrome
  returns `color-mix()` results as `color(srgb 0.89 0.92 0.98)`; a naive `match(/[\d.]+/g)`
  reads 0.89 as an 8-bit channel and reports near-black. That produced two rounds of false
  failures before it was caught.

---

## 9. Sources

- Yealink Action URI parameters and `key=Reboot` / `key=AutoP` — Yealink admin manuals and
  the Action URI configuration guide.
- Remote factory reset via SIP NOTIFY `Event: reset` + `sip.notify_reset.enable` —
  <https://james-batchelor.com/index.php/2019/07/06/yealink-remote-factory-reset/>
- Yealink RPS behaviour and MAC release — <https://www.whichvoip.com/articles/yealink-rps.htm>,
  Yealink MAC removal form, Telavox note on the 2025-10-01 RPS sunset.
- Everything else was read directly off our own PBX and repo.

---

## 10. ⏳ NOT DONE — the honest list

- **Nothing is built.** No adapter, no state machine, no wizard, no IPC channel.
- **Nobody has approved the mockups.** That is the one gate.
- The scanner has never run on a real customer network, from either app.
- Neither live fault in §3 is fixed.
- Firmware update/recovery is deliberately out of phase one.
- Vendors other than Yealink are adapter stubs only.

---

# PART 2 — BUILT (2026-08-21, same day)

Izzy approved the mockups with one change ("number seven: make it better, fix the
pictures") and one standing instruction: **"make everything exactly 100% on the dot
like the mock-ups"**, and **"don't stop between phases, keep going until your stress
test is done completely."** Both done.

⛔ **STATE: CODE COMPLETE, COMMITTED AND PUSHED. NOTHING DEPLOYED, MIGRATION NOT
APPLIED, NO PBX WRITE, AND NOBODY HAS OPENED THE SCREEN.** See §10 for the honest list.

Mockups (redrawn depictions): <https://claude.ai/code/artifact/7a561ef4-9624-4afa-ad19-d59ad9ae4252>
Mockup-vs-built proof: <https://claude.ai/code/artifact/93ca11e8-9c27-40c7-827f-21d648a9d8cc>

Commits on `feat/ivr-migration-takeover`: `ccf8e2cc` (investigation doc) ·
`761d1055` (desktop) · `3908b89e` (api) · `2ade3422` (server wiring) ·
`115dd60b` (portal) · `58104ae6` (photo base) · `1d16d2db` (stress test), plus the
shared core commit immediately before the desktop one.

## 1. What was built, in four layers

| Layer | Where | What |
|---|---|---|
| Rules (pure) | `packages/shared/src/deskPhoneSetup/` | standards · button layout · state machine · device identity · escalation ladder |
| Hands | `apps/desktop/src/phoneSetup/` | lifted scanner · Yealink adapter · operation allowlist · IPC wiring |
| Head | `apps/api/src/deskPhoneSetup/` | 10 routes, 2 tables, 2 permission keys |
| Screen | `apps/portal/components/deskPhones/` + `app/(platform)/settings/desk-phones/` | the wizard, ported from the mockup |

## 2. ⛔⛔ The security boundary, stated once

**The desktop app cannot express anything except five named operations** —
`discover`, `fingerprint`, `test_credentials`, `reboot`, `trigger_autop` — each against
a **private IPv4 address it re-validates itself**. There is no URL parameter, no host
parameter, no command. **Factory reset is deliberately NOT a local capability**: the
reset that matters goes over SIP from the PBX, and the local path gets its own door
with its own authorisation record.

⛔ **Credentials are handed over by REFERENCE.** The renderer calls
`rememberCredential(ref, user, pass)` once; everything after that names the ref. The
password is resolved in the main process behind Electron's `safeStorage` and **never
crosses the IPC boundary in either direction**. A guard test asserts the preload bridge
cannot express a url, host, fetch, exec or command.

⛔ **Rate limits live on the customer's machine, not only on the server** — because the
server is the thing that might be compromised. 30 actions/min, 5 s between anything that
changes a given phone, 15 s between scans.

## 3. ⛔⛔ Never wiping a phone twice

`decideReset()` in `packages/shared/src/deskPhoneSetup/states.ts` is the one function
that must not be wrong. It is pure, it reads the **stored row** rather than anything in
memory, and it fails closed on all five branches: terminal · attempts exhausted ·
already reset · not authorised · allowed.

The route checks it **again** immediately before issuing, because the row is the thing
that survives a crash. Proven in the stress test: **twenty concurrent `advance` calls on
one authorised phone reset it exactly once**, and a brand-new Fastify process (the app
closed, Windows restarted) refuses a second reset.

⛔ **Authorisation is recorded on the RUN, by a person in that office, naming the exact
phones.** A partial list is refused with 400 — an approval covers exactly what the
person was shown. **An admin who sent the setup request cannot supply it.**

## 4. The house standards, and the two live faults they fix

`LOOPCOM_PHONE_STANDARDS`: **America/New_York · 12-hour · automatic DST · backlight
always on · voicemail `*97`**. Applied, never offered.

⛔ Every value was **read off our own working phones**, not a vendor doc:
`timezone = -5|United States-Eastern Time`, `time_format = 0`, `summer_time = 2`.

`templateStandardsDrift()` finds the phones that are wrong today — including
`provisioning.templates` id 21 "BV 106" at `-12|Eniwetok,Kwajalein` and id 3 on manual
DST. ⏳ **Neither has been corrected on the PBX; that is a write and needs a mandate.**

⛔ **The BLF bug IS fixed** (`console_writes.py::save_phone`): the UPDATE branch can now
write the button columns, and only writes the ones the caller supplied — writing them
unconditionally would blank a layout on any unrelated edit, which is the same bug wearing
a different hat. Both guards fail against HEAD. The installer's embedded copy was
re-synced and the 33-case drift guard passes.

## 5. The escalation ladder

Eleven rungs, least destructive first, in `escalation.ts`. **Order is the safety
property** — the already-working check is first, the on-a-call check is second, and the
two stopping conditions are checked **before** anything that would touch the phone again.

⛔ **Two attempts, then halt.** A manufacturer redirect and a customer's own router are
told apart from what the phone comes back holding, and each gets a different, plain
message. Neither is ever retried: a loop is not persistence.

## 6. What proves a phone is Ready

**Only Asterisk.** `deps.isRegistered` is asked, and a throw (PBX unreachable) resolves
to `false` — unknown is never optimistic. Accepting settings is not working.

## 7. The screen

Ported from the mockup: same steps, same order, same words, same values, all classes
prefixed `dps-` and scoped under `.dps-root` so nothing can collide with the portal's
14,000-line stylesheet. Colours come from the portal's own theme tokens, so the wizard
follows the in-app toggle rather than the OS.

⛔ **The card disappears.** It renders on `showSetupCard`, which is false once nothing is
left to do — the customer never permanently sees provisioning terminology.

⛔ **Handset photos are PROXIED** through `/desk-phones/photo/:model`. The portal CSP is
`default-src 'self'`, so an image pointed at the PBX is blocked as a silent console
violation. Verified reachable at the PBX's `provisioning_resources/images/<brand>/<MODEL>.png`
path (200, 51,415 bytes, image/png).

## 8. Test results

| Suite | Result |
|---|---|
| `packages/shared` | **513 / 513** |
| `apps/desktop` | **61 / 61** |
| `apps/api` desk phones | **59 / 59** (27 routes + 32 stress) |
| `apps/portal` | **299 / 301** (the two documented pre-existing) |
| Typecheck | shared 0 · desktop 0 · portal 0 · **api: 0 errors in any file I touched** |

⛔ The api's total is 76 rather than the documented 75 baseline. All three server.ts
errors (lines 23770, 41879, 41881) are pre-existing or another session's
`registerMeetingRoutes` line — **none is in my ranges** (289, 2884–2889, 41844–41859).

## 9. Traps paid for while building this

- ⛔ **Backslash escapes do not survive this shell's heredocs.** `‮`, `\r\n` and
  `\n` were all silently turned into real characters four separate times, producing
  unterminated regexes and string literals. Use python **raw strings**, or build the
  value with `String.fromCharCode`.
- ⛔ **The comment-stripping trap, again** — a negative guard matched the word
  "Ethernet" in its own explanatory comment and failed against correct code. Sixth time
  in this repo.
- ⛔ **`git stash` correctly refused** in this shared tree, as CLAUDE.md warns.
- ⛔ **A button does not inherit `color`** — the choice tiles would have been invisible
  in dark mode. Caught by measuring, not by looking.
- ⛔ **A contrast probe must composite alpha AND handle `color(srgb …)` floats.**
  Chrome returns `color-mix()` in that form; a naive parser reads 0.89 as an 8-bit
  channel and reports near-black. Two rounds of false failures.
- ⛔ **`server.ts` and `packages/shared/src/index.ts` were contested throughout.** Two
  commits went in with the **private-index technique**; a pathspec commit would have
  swept another session's meetings work.

## 10. ⏳ NOT DONE — the honest list

- **Nothing is deployed.** api, portal and desktop are all committed and unshipped.
- **The migration has NOT been applied.** Two new tables; purely additive; generated by
  `prisma migrate diff`, never hand-written.
- **No PBX write has been made.** The two live faults in §4 are found and unfixed.
- **Nobody has opened the wizard in a browser**, and no phone has ever been discovered,
  fingerprinted, redirected or reset by this code. Every proof is a test or a
  measurement.
- **The `templates.provision` path is designed and unexercised.** Generating a settings
  profile for an unknown model writes the full config body into that column; verifying it
  needs one throwaway phone row on production and a render — a PBX write.
- **`reset_over_sip` has no executor yet.** The ladder chooses it and the PBX side
  (`pjsip send notify yealink-reset`) is documented and unwired.
- **Speed-dial key type 13 is from Yealink documentation, not observed on our own
  phones.** Confirm on the first real one; a wrong value cannot affect a phone with no
  speed dials.
- **`apps/desktop-support` still exists.** Retiring it is a deliberate deletion and was
  left for Izzy.
- Firmware update and recovery are out of phase one, by design.

## 11. Acceptance test, when it is deployed

1. Grant yourself `can_setup_desk_phones` and `can_authorize_phone_reset`.
2. Settings → Devices → **Set Up My Phones** in the **desktop app** (a browser cannot see
   the office network, and the wizard says so).
3. Walk to the search step. It should find the desk phones on that network and show each
   one's real product photo.
4. Assign one phone to a person and finish.
5. ⛔ **The negatives matter more:** a phone still on another provider must ask before
   anything is erased; a customer without the reset key must get a plain refusal; and a
   second browser signed into a different customer must get **404**, not 403, on the run.

---

# PART 3 — DEPLOYED, AND WHAT STRESS-TESTING FOUND (2026-08-21, same day)

## 1. Deploy state, verified rather than reported

| What | Evidence |
|---|---|
| Migration `20260821200000_desk_phone_setup` | `finished_at 2026-08-21 23:51:16.400589+00` in `_prisma_migrations` |
| `DeskPhoneSetupRun` | present, **15 columns**, **0 rows** |
| `DeskPhoneSetupPhone` | present, **23 columns**, **0 rows** |
| api container | `.build-commit` grepped; routes, the `PORTAL_API_PERMISSION_RULES` entry and the shared rules all found **inside** `app-api-1` |
| portal container | `.next` grepped for `dps-root`, `dps-wz`, `Set up desk phones`, "Do you know what kind of phone you have" — all present |
| Live | `/settings/desk-phones` **200 on both hostnames**; `/api/health` 200 on both; **0 restarts** on either container |

⛔ **0 rows is the important number.** No run exists, so the feature is inert: nothing
changed for any customer on deploy, and it stays that way until somebody opens the wizard.

⛔ **The deploy's exit line is never the proof.** Both halves were judged by grepping the
running container for a real string — the portal by its own CSS class names and copy,
never by a function name (minification renames those and a 0-hit grep reads exactly like a
failed deploy).

## 2. ⛔⛔ FINDING ONE — an SSRF bypass in the address fence

`isPrivateIpv4()` parsed each octet with `Number()`. **`Number("010")` is 10**, while the
OS resolver — and `inet_addr`, which is what the platform actually uses — reads a
leading-zero octet as **octal**, so `010` is **8**.

So `010.0.0.1` passed our fence as *"10.0.0.1, private, allowed"* and the request was then
sent to **8.0.0.1 — a public address on the internet.**

Measured by replaying the fuzz corpus against `HEAD`: **4 of 5 hostile addresses got
through**.

✅ **The fix is not a better regex.** Two parts, and the second is the one that matters:

1. `canonicalPrivateIpv4()` refuses **any** octet with a leading zero outright, refuses
   anything that is not 1–3 plain digits, and re-checks the range.
2. **The request is rebuilt from the canonical parsed form**, so the string that was
   validated is byte-for-byte the string that is dialled. A fence that validates one
   string and dials another is the whole bug class; closing the parser without closing
   that gap leaves the next variant live.

⛔ **This was found by fuzzing, not by reading.** The original code looked correct, was
reviewed, and passed every hand-written test — because every hand-written address was
written the way a person writes an address.

## 3. ⛔⛔ FINDING TWO — ownership was not the first check

`POST /desk-phones/runs/:id/authorize-reset` answered:

- **400** when the body was empty — because zod validation ran first;
- **403** when the caller lacked `can_authorize_phone_reset` — because the permission ran
  first;

both **ahead of** the **404** that another customer's run is supposed to produce.

Neither is exploitable on its own: a run id that does not exist answers exactly the same.
But *"another customer's run is indistinguishable from one that never existed"* is the
property that is simple to state, simple to test and simple to keep true for years — and
it only holds if **ownership dominates everything**.

✅ Every run-scoped route is now **`ownRun()` → permission → body**. `ownRun()` resolves
the run scoped to the caller's own tenant and answers 404, so no later check can leak
anything about a run that was never theirs.

⛔ **`mayAuthorizeReset()` was deleted, not left unused.** It resolved the caller and
checked the reset permission in one step, which forces 403 ahead of 404 *by construction*
— and a dead helper with a security-shaped name is an invitation to put the bug straight
back. The comment left in its place says so.

⛔ **The `/admin/` routes are deliberately cross-tenant** — Loopcom support looking at a
customer's setup is the entire point of them — so `ownRun()`, which scopes to the
*caller's* tenant, would be exactly wrong there. They are held to the stricter rule
instead: **staff-gated before they read anything at all**, which the guard now asserts.

## 4. ⛔⛔ The rule both findings earned

**A green suite proves the cases somebody thought of. Randomised and exhaustive driving
proves the ones nobody did.**

Neither defect was findable by reading the code, and neither was findable by any
hand-written test — because the same person writes the code and the test, and shares its
blind spot. What found them was driving the real thing with inputs nobody would choose.

Three suites now do that permanently:

| Suite | What it drives | Scale |
|---|---|---|
| `deskPhoneInvariants.test.ts` (shared) | the pure decision functions | **all 8,192 phone conditions × 384 records** — 3.1M+ decisions |
| `deskPhoneChaos.test.ts` (api) | the **real Fastify routes** in random order | 300 seeded runs × 40 steps + a 500-step run; 12,000+ operations |
| `phoneSetupAdversarial.test.ts` (desktop) | the address fence and the capability layer | the fuzz corpus that found the SSRF |

What the invariant suites assert, after **every single step**:

- no phone is ever reset without an authorisation recorded on its run;
- no phone is ever reset twice, under any interleaving or any concurrency;
- nothing disruptive happens to a phone that is on a call;
- nothing happens past the attempt cap;
- every action is inside the closed list of 13;
- **no customer-facing string ever contains jargon** (HTTP, a status code, SIP, DHCP,
  MAC, subnet, firmware, provisioning …) and every customer status is one of the six
  permitted words;
- the customer view never carries `mac`, `ip` or `provisioningUrl`;
- a phone never escapes its customer, and there is never more than one live run.

⛔ **The chaos generator is seeded (xorshift32) and prints its seed with any failure**, so
a chaos failure is reproducible rather than a ghost.

⛔ **`deskPhoneRouteOrder.test.ts` reads the route file's SOURCE.** A line ORDER cannot be
seen by a behavioural test of any single call and cannot be expressed as a type. **4 of
its 7 tests fail when replayed against `HEAD`**, which is what makes it a guard rather
than decoration. The 3 that pass there are properties the code already had — recorded
honestly rather than inflated.

## 5. Test totals after the hardening

| Package | Before | After |
|---|---|---|
| `packages/shared` | 513 | **537** |
| `apps/desktop` | 61 | **77** |
| `apps/api` desk-phones | 59 | **72** |

All green. Typecheck: shared, desktop and portal **0**; **apps/api adds 0 errors in any
file touched** (its total reads 76 against the 75 baseline entirely because of another
session's in-flight `server.ts`, `ops/` and `delivery/` work — checked file by file).

## 6. ⏳ Still not proven, stated plainly

- **Nobody has opened the screen and no phone has been set up.** Everything above is a
  test, a measurement or a container grep — never a person clicking.
- **The desktop app is not built or published.** That renames and re-signs the app for
  every customer, so it is Izzy's call. Until it ships the wizard can be opened but the
  office machine cannot scan, so the acceptance test is still **one real phone on one
  real desk**.
- **The two live PBX faults are still live** — template id 21 on the Marshall Islands
  (17 hours out) and template id 3 on manual DST. Correcting them is a PBX write and
  needs Izzy's mandate.
- `reset_over_sip` has no executor; the `templates.provision` generation path for an
  unknown model is designed and unexercised; firmware update and recovery are out of
  phase one by design.

## 7. ⛔ The ordering fix, PROVEN LIVE on production (read-only)

Driven against `127.0.0.1:3001` inside `app-api-1` with a 60-second self-signed token,
every call aimed at a run id that does not exist — so each one answers before it writes
anything, and nothing was created:

```
404  authorize-reset, EMPTY body        (was 400)
404  authorize-reset, phoneIds: []      (was 400)
404  authorize-reset, phoneIds: 5       (was 400)
404  authorize-reset, valid shape
404  advance / assign / discovered, junk bodies
404  GET run · GET run?view=diagnostics · GET buttons
404  hostile ids (traversal, quote-injection, 300 chars)
200  GET /desk-phones/state  ->  hasActiveRun: false
```

⛔ **The last line is the one that matters most: `hasActiveRun: false` is the live
confirmation that the feature is inert.** Deployed, reachable, and doing nothing to
anybody until a person opens the wizard.

### ⛔⛔ A nuance the probe exposed, worth knowing before reading a 403 here

There are **two** gates, and the outer one fires first. A real `TENANT_ADMIN` probing the
same eleven paths got **403 on every one**, from the global
`PORTAL_API_PERMISSION_RULES` entry `{ prefix: "/desk-phones", permission:
"can_setup_desk_phones" }` — which runs as a preHandler, **before the route body
executes at all**.

So the honest statement of the property is:

- a caller who **cannot** reach the handler sees a **uniform 403 for every run id**,
  existing or not — which reveals nothing about any run, and is not an oracle;
- a caller who **can** reach the handler sees **404** for a run that is not theirs,
  ahead of the reset permission and ahead of body validation — which is what §3 fixed.

⛔ **Do not read the outer 403 as the in-handler order being wrong**, and do not "fix" it
by moving the prefix gate — that gate is what stops an unprivileged caller reaching this
surface at all, and it is uniform, so it leaks nothing. The two gates answer different
questions: *may you be here at all* and *is this yours*.

---

# PART 4 — THE SECOND FULL PASS (2026-08-22, on Izzy's ask)

"Can you take a full other pass on this to make sure that everything is built correctly
and stress test again? Go over the mockups and see if we can make it better."

Fresh-eyes review of every file, harder stress, and a screen pass. **Five real findings**,
every one shipped with a guard that fails against the pre-fix tree.

## 1. ⛔⛔ The wizard never drove the setup — the biggest gap of the whole build

The api's `advance` route decided what each phone needs. The desktop capability layer
could perform it. **Nothing connected them.** The live step only polled, so pressing
"Set Up My Phones" would have sat on "Setting up your office" forever — with every
suite green, because the stress tests drove `advance` themselves.

✅ `apps/portal/components/deskPhones/setupDriver.ts` is the loop: each tick asks the
server per phone, performs the instructions this machine can perform
(default-credential check → records what it learned; fetch-your-settings; re-find after
a restart, reported by hardware id), and reports back. **The server stays the only
decider.** Bounded: a non-executable instruction is not hammered (3-stall cap), a
re-entry guard stops a slow tick overlapping the next, a failing phone does not stop
its siblings. 10 tests, registered.

⛔ The live step's copy changed from "you can close this window — setup keeps going"
to **"keep this window open while we work"** — the office machine is doing the work,
so the old sentence would have quietly stopped a setup the moment somebody believed it.

## 2. ⛔⛔ The two person-only moments had no screen

`resetAuth` sat in the Step type and was never rendered. The live step now surfaces:

- **ONE approval card for the whole batch** of phones needing clearing (ten dialogs
  teaches people to click through), posting `authorize-reset` with the exact ids the
  card named. A caller without `can_authorize_phone_reset` gets the route's own
  plain-English refusal.
- **A password card per locked phone.** The password goes through
  `bridge.rememberCredential` into the desktop's protected store (DPAPI); only the
  REFERENCE ever travels. The card says "The password stays on this computer. It is
  never sent to Loopcom" — and a source guard asserts the driver has no `password:`
  object key anywhere.

## 3. ⛔⛔ A printer fleet could become a phone list

`scanLan` returns **every ARP entry** — the wizard fingerprinted and submitted all of
them, so an office with 4 phones and 19 other devices opened on "We found 23 desk
phones". ✅ `packages/shared/src/deskPhoneSetup/discoveryFilter.ts`: a device is a
phone only on **evidence** (fingerprint, or a phone-maker hardware block — which is
what still shows a LOCKED phone that refuses to talk); everything else is counted for
the honesty line — *"We also saw 19 other devices … we left those alone"* — and never
submitted. `shouldFingerprint` bounds the probe spend: 4 seconds per silent laptop
also burned the capability's 30-actions-a-minute budget.

## 4. ⛔⛔ The reset issue was check-then-act, not atomic

Two `advance` calls landing at once both read `resetCount=0`, both passed
`decideReset`, and both issued a wipe. **The chaos suite could not see it**: awaits
alone march concurrent handlers in lockstep under the microtask queue — every write
lands before the next read — so the race never fired in test while being real in
production. With a one-tick read/write delay modelling database latency, **the pre-fix
route issued FIFTEEN reset instructions from fifteen concurrent advances** (replayed
and measured); the fixed route issues exactly one.

✅ The claim is an `updateMany` guarded on the `resetCount` and `state` that were
read — the same single-use-claim pattern as everywhere else in this repo. ⛔ The
concurrency test counts **audited reset issuances, not the counter** — both racers
wrote `resetCount=1`, which is exactly how the race hid. ⛔ The fake db's reads
return **snapshot copies** now: a fake that hands back the live shared row lets the
second caller see the first's mutation and masks every race of this shape.

## 5. ⛔ Three smaller ones

- **`applyYealinkStandards` replaced only the FIRST occurrence** of a managed key.
  Yealink config is last-value-wins, so a duplicated key kept the vendor's later line
  winning on the handset while the file read as fixed. Every occurrence is rewritten
  now; a key with a Blade placeholder anywhere has ALL its copies left alone.
- **The adapter caught its own fence throw** inside the transport try, reporting a
  REFUSED address as retryable "unreachable". The fence runs before the try now.
- **The "Connecting" pill failed contrast** — 4.42 dark / 3.87 light as 11px text,
  both under the 4.5 small-text bar. Ink token per theme; now 6.00 / 6.08. Full sweep
  after: **40/40 text elements AA in both themes, zero overflow.**

## 6. Screen improvements (the "make it better" half)

- "Do you know what kind of phone you have?" **now takes the answer** — the approved
  copy promised "tell us and we will go straight to it" and then never asked. Choosing
  Yes opens a box; the found screen echoes it back against the pictures.
- The connection answer **now shapes the nothing-found explanation** (Wi-Fi → check
  the Wi-Fi name; cable → follow the cable), which is what its own copy promised.
- Comparison, rendered with the shipped stylesheet byte-for-byte in both themes:
  <https://claude.ai/code/artifact/7632e24e-4526-45ca-a6f1-4d412785529d>

## 7. State after the pass

Deployed: api at `76d29379` (atomic claim grepped in the container, `updateMany` ×2);
portal at `17b20ab3` carrying the driver (all five new strings grepped in the shipped
`.next`); the pill-fix tip deploy follows. Totals: shared **542**, desktop **77**, api
desk-phones **72**, portal **309/311** (the two documented pre-existing) — all green,
typecheck 0/0/(+0)/0.

⏳ Still true: nobody has opened the screen, the desktop app is not published, the two
PBX template faults stand, and `reset_over_sip` / `set_provisioning` / `check_sync` /
`generate_template` have no executor — the driver treats those as waits, so a phone
needing one of them ends honestly at "Needs attention" or waits, never in a loop.

---

# PART 5 — IZZY'S FEEDBACK ROUND: any VoIP device, and the two questions became full pages (2026-08-22)

His words, in order: *"are these all the pages, only four pages?"* · *"I don't see where
they can clear the phone… oh, see, I do see — but it took me a second to realize how
it's working. Dumb people will just get stuck here, so dumb it down."* · *"What if they
don't know their password?"* · *"they should be able to select which one should be
cleared, not just clear all phones."* · *"it's not just desk phones. Any VoIP device …
a Grandstream HT device … a wireless cordless Yealink base station … a doorbell … a
Fanvil PA device. The system should be able to connect all of them automatically."* ·
*"if it's a Grandstream HT device, it always has to block incoming calls from other
places. Only from the SIP URL … always Eastern time zone."* · *"it should be able to
clear all these devices as well."*

## 1. ⛔⛔ ANY VOIP DEVICE — the kind model (`packages/shared/src/deskPhoneSetup/deviceKinds.ts`)

Six kinds: `desk_phone`, `ata` (Grandstream HT boxes), `cordless_base` (Yealink W-series),
`pager` (Fanvil PA), `doorbell` (Grandstream GDS, Fanvil i-series), `unknown`. **The kind
decides three things, and nothing else may branch on a model string:**

1. **What the customer is told it is.** "Small box your regular phones plug into" —
   never "ATA", never "FXS". `describeKind()` feeds the wizard's rows.
2. **Which house rules apply.** `kindRequirements()`:
   - ⛔⛔ **Grandstream HT: accept incoming calls ONLY from the SIP server it is
     registered to, always Eastern time** — Izzy's rule verbatim. An HT with that
     switch off rings its analog phones for any SIP scanner that finds it.
   - ⛔ **A doorbell or a ceiling speaker gets the SAME inbound lock** — a device that
     opens a door or speaks into a room must never take instructions from anything but
     our server.
   - Everything gets Eastern time; no kind escapes it (tested).
   - ⛔ **The exact vendor config codes are NOT in the repo** — deliberately. A wrong
     Grandstream P-code silently configures nothing; they get captured off a real
     device's config before the template writer ships, per the house never-invent rule.
3. **Whether the office machine may drive it locally.** `vendorSupportsLocalActions()`
   — Yealink only. The adapter speaks Yealink's documented mechanisms; sending those
   at another vendor's device is not "worth a try". Other vendors are configured
   SERVER-side (the provisioning template), and locally the driver waits.

Also: discovery recognises Grandstream (IEEE `000b82`, `c074ad`) and Fanvil (`0c383e`)
hardware blocks and their fingerprint banners, so an HT box on a shelf lands in the
list instead of being filtered as "other device". **Only desk phones ever get BLF
layouts** — `buildButtonLayout` answers capacity 0 for every other kind.

⛔ **Clearing covers every kind, and the proof is structural:** `decideReset` takes the
RECORD, and the record has no kind field — an HT box and a doorbell ride the identical
authorisation, once-only and attempt-cap gates as a desk phone.

## 2. ⛔⛔ The clearing question is a FULL PAGE with a tick per device

Izzy took a second to find the compact card and said dumb people would get stuck. Now:
when a decision is needed **the wizard stops** — no progress list, no competing
information. One question fills the screen: what these devices still hold, what
cleaning does, what is NOT touched. **Every device is a row with its own checkbox**
(photo, person, ticked by default); the big button counts exactly the ticked ones
("Clean 2 phones — go ahead"); "Skip all of these for now" is a real path.

⛔ **An unticked device is a deliberate no, recorded as `resetDeclined`** — new
`PhoneCondition` field, threaded wizard → driver → advance route → ladder. The ladder
ends that device's setup kindly ("we left this phone exactly as it was…"). **Proven
exhaustively: a declined device is never wiped and never re-asked, from every record
and every surrounding condition.**

## 3. ⛔⛔ "I don't know the password" is a complete answer

The password question is its own full page: where the password might be (sticker under
the phone, an old email), "don't dig", and a **big "I don't know it — Loopcom can sort
this one out" button**. Pressing it sets `passwordUnavailable` (also new on
`PhoneCondition`); the ladder halts that device with the support hand-off — *"No
problem — plenty of people never got that password."* — while the rest keep going.

⛔ Before this branch existed the wizard asked forever. **Proven exhaustively: after
"I don't know it", `ask_for_password` and `try_default_credentials` are unreachable.**

## 4. The exhaustive space grew with the model

`PhoneCondition` is 15 booleans now — **32,768 conditions × 384 records = 12.6M
decisions per invariant**, every invariant re-proven. The chaos suite's random advance
bodies carry the two new fields.

## 5. The artifact answers "are these all the pages"

<https://claude.ai/code/artifact/7632e24e-4526-45ca-a6f1-4d412785529d> — **all twelve
screens in walking order**, shipped stylesheet, including the two new full-page
questions and a found-list showing every device kind in its plain words.

## 6. Totals

shared **549/549** · desktop **77/77** · api desk-phones **72/72** · portal **316/318**
(the two documented pre-existing). Typecheck: shared 0, desktop 0, portal 0, api +0 in
any touched file.

## 7. ⏳ Honest ledger for the wider scope

- The kind model classifies, describes, fences and rules — **but no Grandstream or
  Fanvil device has ever been driven**, and their reset/config executors do not exist
  yet. First real HT box on a real shelf is the acceptance test for the kind half.
- `kindRequirements` is DATA the template layer will consume; the
  `templates.provision` generation path is still the designed-unexercised one.
- Everything from Parts 3–4's ledger still stands: nobody has opened the screen, the
  desktop app is unpublished, the two PBX template faults need Izzy's mandate.

---

# PART 6 — THE APP SHIPPED, AND THE SIDEBAR DOOR (2026-08-22)

## 1. Desktop 0.1.8 is BUILT AND PUBLISHED — the wizard's hands are on the fleet's next update

Izzy: "rebuild the Windows app, build it in … publish it as an update", plus the icon
refinement kit ("use 2b").

- **The icon is the chosen blue-2b refinement tile, verbatim** — the 1024 master pinned
  into `docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/`, rendered per frame
  by `scripts/desktop-loopcom-windows-assets.py` (now sourcing the tile; the <=32px
  frames get one gentle unsharp pass so the white-on-blue mark survives the taskbar
  sizes). Proven: 256/48 frames diff **0.00** against a straight master resize.
  ⛔ CORRECTION recorded in the generator: an earlier probe misread the ALPHA channel
  as "white corners" — the corners are brand blue and the tile is square edge to edge.
- **The never-Electron safeguards all ran against the ARTIFACT**: `verify:icon` read the
  built `Loopcom.exe` — **7 RT_ICONs byte-identical to the new icon.ico, nothing else
  embedded**. `signAndEditExecutable` stays on. The toast stays two text nodes with NO
  image — the kit's `loopcom-toast-*.png` are pinned in the brand folder and
  **deliberately NOT wired** (an Electron toast image renders full-width inline, the
  exact "big-ass icon" that was removed; the small header icon comes from the exe).
- **The phone-setup hands ship for the first time**, verified inside the packed asar:
  main registers `registerPhoneSetup`, preload exposes `phoneSetup:run` +
  `rememberCredential`, the five-operation capability fence is in `dist/phoneSetup/`.
- **PUBLISHED**: `Connect-Setup-0.1.8.exe` + blockmap + `latest.yml` on
  `/opt/connectcomms/desktop/`, `Connect-Setup-latest.exe` alias updated, `latest.yml`
  answering **0.1.8 on both hostnames**. Installs >=0.1.4 auto-update within ~3h.
  ⛔⛔ **Each update renames the customer's app Connect → Loopcom with the new icon**
  (the rebrand rides this build) — if a customer says their app vanished, tell them to
  look for the blue tile. Watch the first upgrade for a leftover `Connect.exe`/`.lnk`.
  ⛔ The winCodeSign workaround had vanished from the cache — recreated as
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (copy of the
  newest numeric temp dir), per the rebrand handoff §2.

## 2. The workspace sidebar door — one key, three surfaces

`workspace.desk_phones` → `/settings/desk-phones`, permission
**`can_setup_desk_phones`** — the SAME key the page's PermissionGate and every api
route already gate on ([[a-gate-must-agree-with-the-gate-behind-it]]).

The whole visibility model falls out of existing machinery, **no new key, no snapshot
migration**: the key is in NO default bucket, so **only SUPER_ADMIN sees the item
today** (the force-add bucket); it is an ACTION key, so the **custom-roles editor
already offers it**; and the nav entry is what makes it appear in **/admin/permissions**
for built-in roles. ⛔ Deliberately NO hardcoded rule in `isNavItemVisibleForUser` — a
force rule would make the permission toggles a lie, and a guard test pins its absence.

⛔ **Placement lesson: the Conference guard did its job.** First insertion put Desk
Phones between Conference and Install — and `conferencePage.test.ts` failed, because
"Conference immediately before Install" is Izzy's exact recorded 2026-08-20 placement.
Desk Phones sits ABOVE Conference instead. **Two recorded instructions collided and the
one with the exact pin won.**

Deployed: portal `35b13bce`, nav item grepped in the shipped bundle, health 200 both
hostnames, installer serving 206 on both, 0 restarts. Portal 319/321.

## 3. ⏳ Ledger updates

- The Windows app is **published now** — the "desktop half not shipped" caveat from
  Parts 2–5 is CLOSED. The wizard can genuinely scan once a customer's machine takes
  the 0.1.8 update.
- The acceptance test is unchanged and now actually runnable: **one real device on one
  real desk**, driven from Settings → Desk Phones (or the new sidebar item) in the
  updated app.
- The kit's mobile icons (android/ios/notification `ic_stat_*`) are pinned in the brand
  folder for the NEXT mobile build — mobile assets were another session's in-flight
  work and were not touched.

## 4. ⛔⛔ THE FIRST LIVE RUN FAILED — the /22 lesson (2026-08-23, fixed, 0.1.9 published)

Izzy pressed Find My Phones on the first updated install — his own home — and got
"we found 0 phones". Traced from both ends (his machine + the server):

- **His LAN is a /22** (192.168.6.102, mask 255.255.252.0 — an eero-class home-mesh
  default). The scanner accepted only /24 → nothing to sweep. Now: /22–/24, aligned
  to the true base (his .6.x machine yields **192.168.4.0/22**, where his router
  really sits at 192.168.4.1); wider is refused in BOTH `localScannableSubnets` and
  `hostsInSubnet`; the ARP filter is a range test now (`ipInSubnet`) — `startsWith`
  can only express a /24.
- ⛔⛔ **The wizard showed the FAILED scan as an empty office.** `scanLan` returned
  `outcome:"failed"` + a plain-words note; the wizard checked only `!scan.ok`,
  dropped the note, submitted an empty list, and rendered "we found 0 desk phones" —
  "you have no phones" when the truth was "we never looked". The wizard now surfaces
  the scanner's own note and returns to the network step. Guard fails against HEAD.
- **Diagnosis recipe** (reusable): `DeskPhoneSetupRun` rows → nginx for the
  `POST …/discovered` **byte size** (73 bytes = empty list, so the bridge ran and
  submitted nothing) → `ipconfig` + `arp -a` on the reporting machine.
- Shipped: desktop **0.1.9** published (latest.yml on both hostnames), portal at
  `b5272867` with the honesty strings grepped in the bundle. desktop 81/81,
  portal 320/322.
- ⏳ Also surfaced: his SUPER_ADMIN login's tenant has **no extensions**, so that
  login can find phones but has nobody to assign them to. A full end-to-end run
  needs a login on a real tenant that holds `can_setup_desk_phones`.

## 5. Desktop 0.1.10 — the designer's own Windows frames (2026-08-23, PUBLISHED)

Izzy saw the tile build on his taskbar: *"the icon is not showing up here … I just made
two new ones to be made for Windows"* — two zips, one per variant, each holding
hand-tuned `loopcom-win-16/32/48/64/256.png` with rounded corners and REAL
transparency. The generator now ships those five frames **verbatim** (proven diff 0
byte-for-byte) and synthesises only 24 and 128, one LANCZOS step each, **no
sharpening** — processing a hand-tuned frame is a redesign wearing a helpful hat.
`icon.png` is the designer 256 as-is (a 512 upscale is blur). Variant stays blue-2b;
navy-2a's Windows set is pinned beside it. verify:icon passed on the built exe;
`latest.yml` answers **0.1.10** on both hostnames.

⛔ **The lesson: when the designer delivers per-size frames, USE THEM PER SIZE** — the
first Windows build downsampled the 1024 iOS tile algorithmically, and no unsharp pass
makes a 16px downsample compete with a frame drawn at 16px.

## 6. Desktop 0.1.11 — the icon follows the OS theme, proven live (2026-08-23, PUBLISHED)

Izzy: *"the icon changes whether the person has dark mode or light mode … 2A would be
dark mode. 2B would be the light mode. But test it. Make sure it actually changes.
With the toggle, instantaneously."*

- ⛔ **What cannot follow a theme, stated once:** the exe-embedded icon (Start menu,
  pins, toast header) is one per program — Windows reads it out of the executable.
  It stays blue-2b. **What does switch, live:** `src/themeIcon.ts` maps dark →
  navy-2a (`icon-dark.*`) and light → blue-2b (`icon.*`); a `nativeTheme "updated"`
  watcher re-images the tray and every window the moment the toggle moves.
- ⛔ `iconPath` became a **per-call resolver**; a guard pins that it can never go
  back to being resolved once at module load — that shape would make the swap a lie.
  A second guard asserts every size of BOTH variants exists in assets, because
  `createFromPath` on a missing file yields an EMPTY image and the swap becomes a
  silent no-op.
- ✅✅ **PROVEN LIVE, per his instruction — not by unit test.** A throwaway Electron
  harness ran the compiled module with a real tray and window on his own machine
  while the actual `AppsUseLightTheme` registry value was flipped four times:
  **every swap landed within ~95 ms**, and the log recorded the applied artwork's
  own pixels — light RGB(37,117,255) vs navy RGB(11,16,32) — so the proof is the
  artwork changing, not a filename. Rapid double-flip correct; his theme restored
  to light where it started; harness deleted.
- PUBLISHED: `latest.yml` answers **0.1.11** on both hostnames. desktop **85/85**,
  typecheck 0, verify:icon OK.

## 7. Desktop icon: two live-found fixes after 0.1.11 (2026-08-23)

**0.1.12 — the taskbar follows the SYSTEM theme.** Izzy runs Windows split mode:
system/taskbar DARK, apps LIGHT. The taskbar sits on the system surface, but
`nativeTheme.shouldUseDarkColors` is the APPS value, so 0.1.11 keyed on the wrong half
and showed light-blue on a dark taskbar. `themeIcon.ts::resolveDark()` reads
`SystemUsesLightTheme` from the registry (0 = dark), falls back to nativeTheme only on
a failed read, and re-checks on a 15s poll — Windows fires no event for a system-only
change. Proven live on his exact config.

**0.1.13 — the blank "paper" taskbar icon was a TIMING race, not a bad icon.** Every
artifact verified correct: exe embed valid (`ExtractAssociatedIcon` → blue), every
`.ico` frame 97-100% opaque, AUMID matched runtime, the live window reported valid
HICONs (`WM_GETICON` non-zero). The taskbar button is created a beat AFTER first paint,
and the initial `setIcon` lands before it exists and is dropped. `pinWindowIcon`
re-asserts on a 120/400/1200ms ladder after first show. ⛔ Diagnosis order for a blank
Windows taskbar icon: exe embed → frame opacity → live HICONs → THEN cache/timing;
the art is the last suspect, not the first. Clearing Explorer's `iconcache*` +
`thumbcache*` must be done with the app CLOSED or a held handle defeats it.

## 8. The blank "paper" taskbar icon — an AUMID orphan, not an icon (0.1.14, 2026-08-23)

Days of "the icon still isn't there" resolved to a cause that had nothing to do with
the icon. Windows resolves a running window's taskbar-BUTTON icon from the Start Menu
shortcut whose `System.AppUserModel.ID` matches the window's AUMID — not from the
window's own HICON. Izzy's machine carried a stale `Electron.lnk` with the app's AUMID
pointing at the **deleted `Connect.exe`**; a dead target renders as the generic paper
icon.

Everything else was perfect and that is exactly what made it hard: `ExtractAssociatedIcon`
on the exe returned blue, every `.ico` frame was 97-100% opaque, the live window's
`WM_GETICON` returned valid non-zero HICONs, and the shortcut AUMID matched the runtime
one. The icon was never the problem.

⛔ **Diagnosis (`findaumid.ps1`):** enumerate every `.lnk` under Start Menu / Quick
Launch / Desktop, read `ExtendedProperty("System.AppUserModel.ID")`, and check each
target exists. The dead one is the culprit.

⛔ **Fleet fix:** `apps/desktop/build/installer.nsh` (force-added — `build/` is
gitignored; electron-builder auto-includes it) deletes `Electron.lnk` / `Connect.lnk` /
`Connect Communications.lnk` from Start Menu + pinned-taskbar on every install.

⛔ **Two things that cost time and are worth knowing:** GDI screen capture cannot see
the Windows 11 taskbar (it is a separate DWM layer — captures show the windows/desktop
beneath), so a taskbar icon cannot be verified by an automated screenshot. And Explorer's
`iconcache*`/`thumbcache*` clear only sticks with the app CLOSED. 0.1.13 also added a
`pinWindowIcon` re-assert ladder for the unrelated late-button timing race.

---

## §13 — The first customer holds the key: A plus center ext 103 (2026-08-25)

Izzy: *"A plus center 103 — permission to add desk phones, and add it to his
sidebar."* **Permission change only — no code, no deploy, no migration, no PBX
write.** Everything below was driven through the REAL admin routes as
SUPER_ADMIN against `127.0.0.1:3001`.

**Who.** `cmnmjhjgs002vp96hstcfzhnw` — **jacobw@apluscenterinc.org**, Jacob
Weinstock, ext **103**, tenant `cmnlgnumi0000p9g6l7t1t0z7` = **A plus center**.
⛔ That is the real April tenant; the 2026-08-18 duplicate "a plus center" was
renamed **TYH Industries** and is a different company — check the id, not the
name.

### ⛔⛔ The trap: his existing custom role belongs to three companies

He is `role: USER` and already had ONE active custom role — **"S m Weiss"**
(`cmq9mt87n039rrw13ay3d13gr`, 76 keys), which lives under
`connect-admin-tenant-v1` and is assigned to **three users in three unrelated
tenants**:

| user | company |
|---|---|
| relaxtires@gmail.com | Relax Tires |
| senderweiss@gmail.com | Create A Box |
| jacobw@apluscenterinc.org | **A plus center** |

**Ticking a box on "his role" would have handed desk-phone setup to two other
customers Izzy never mentioned.** Run
`GET /admin/custom-roles/:id/users` before editing any custom role.

### What was done instead — an additive second role

`getEffectiveCustomRolePermissions` (`platformRolePermissions.ts:214`) looks
assignments up by **`userId` alone** and **UNIONS every active role**. So a
second role carrying only the new key is purely additive:

1. `POST /admin/custom-roles` → `cmt8ulg430abbpn13k5fai5x7`
   *"Desk phone setup — Jacob Weinstock (A plus center)"*, permissions
   `["can_setup_desk_phones"]`.
2. `PUT /admin/users/<uid>/custom-roles` with **both** ids.
   ⛔ That route is **REPLACE** — it deletes every assignment under the actor's
   tenant first. Omitting the existing id strips the man's entire portal.
3. Verified `GET /admin/users/<uid>/effective-permissions`.

**Result: 76 → 77 keys. `GAINED: ["can_setup_desk_phones"]`. `LOST: []`.**
Both other holders of the shared role re-read afterwards: unchanged.

⛔ **`can_authorize_phone_reset` was deliberately NOT granted.** §2's split is
the point — the wizard points phones at us, a reset **ERASES a customer device**.
Izzy asked to *add* phones. A phone still owned by the previous provider will
need clearing, and that is a separate decision with a separate key.

### The sidebar needed no code change

`workspace.desk_phones` in `navConfig.ts` has **no SUPER_ADMIN force line** in
`isNavItemVisibleForUser` (unlike Meetings, Direct, PBX Console…), so visibility
is exactly `can_view_section_workspace && can_setup_desk_phones`. He already held
the section key. Read from the field the sidebar actually uses — **`/me` →
`portalPermissionSet`**, not `permissions` (a probe on the wrong field reported 0
keys and looked like a failed grant).

### Proven live, both directions

| caller | `GET /desk-phones/state` | `/me` set | sidebar |
|---|---|---|---|
| Jacob (103) | **200** `hasActiveRun:false` | 77, both keys true | **visible** |
| Leah (101, same tenant) | **403** `permission: can_setup_desk_phones` | 42, key false | hidden |

The 403 is the half that matters: the grant is scoped to **him**, not to
A plus center.

### ⏳ Not proven

Nobody has opened the screen and no phone has been set up — his last login was
**2026-06-17**. ⛔ **He must open it in the Loopcom DESKTOP app**, not a browser:
the LAN scan runs on his own machine over the desktop `phoneSetup` IPC (needs
≥ 0.1.9 for the /22 subnet fix, §b5272867). In a browser the page loads and says
*"Open this in the Loopcom app on a computer in the same office as your phones"*
and finds nothing — that is correct behaviour, not a broken grant.

---

## §14 — The first live run's three reports, fixed the same hour (2026-08-25, `42f0c2d3`)

Izzy, testing at A plus center on ext 103's login minutes after §13's grant:
*"I know I have more phones than… six desk phones that I found. And it's not
telling me the names of the phones either. mac addresses should all be
displayed."* All three root-caused from the run's own rows
(`cmt8v34vb005bpc13popbg5cs`, subnet 192.168.0.0/24, 6 phones) and fixed in
`42f0c2d3` (api + portal).

### 1. Vendor "unknown" on all six — the OUI evidence was thrown away

The scan admitted all six devices BECAUSE their hardware addresses matched
phone-maker blocks (5 × `0c383e` = Fanvil — the room speakers/door units;
1 × `805ec0` = Yealink, ext 102's T42S). But the stored `vendor` came only from
`h.fingerprint?.vendor`, and a locked web page fingerprints as "unknown" — so
the very fact that admitted the device never reached the row. **The ingest now
falls back to `guessVendorFromMac`** (a vendor the device itself admitted still
wins). ⛔ Fixed at the SERVER ingest so both submit paths (wizard + driver) get
it — the two-publish-paths lesson.

### 2. No names — the join was never built, and its helper was dead on arrival

⛔⛔ **`listPbxProvisionedPhones` had NEVER returned a row in its life:** it
selected **`pm.name`**, and `provisioning.phone_models` has NO `name` column
(it is `pm.model` — live schema: `id, brand_id, model, …`). Every call threw
"Unknown column", the catch classified it `pbx_unavailable`, and the function
reported the whole PBX as unreachable. Invisible because the lan-phones screen
(its only caller) has never been used. **The rule: a helper that has never had
a real consumer has never been proven — its first customer is its first test.**
Fixed to `pm.model`, source-guarded (comment-stripped — the doc block quotes the
broken name; **guard replayed against HEAD: both assertions fail there**), and
extended with the accounts join (`provisioning.accounts` → `ombu_devices` →
`ombu_extensions`) so each MAC resolves to its extension + the person's name.
`PROVISIONING_GRANT_SQL` now lists `provisioning.accounts` too — ✅ moot on this
PBX, `connect_read` holds `provisioning.*` since 2026-08-19.

The ingest then runs the MAC → record join, best-effort (a PBX that cannot be
read costs the names, never the discovery — everything in one try/catch):
fills `model` + `vendor`, and where the record maps to a Connect Extension it
writes the SAME `{extensionId, extNumber, displayName}` a human's assign click
writes. ⛔ **Never over a human's assignment** — the guard is
`!row.extensionId && !row.extNumber`, tested ("a human's assignment is never
overwritten by the record"). Injectable as `deps.provisionedPhones` for tests;
the in-module default resolves TenantPbxLink → PbxInstance →
`listPbxProvisionedPhones`. ✅ The exact join replayed read-only against the
live PBX resolves **all 9** of A plus center's provisioned devices to people
(101 Leah Fulop, 102 Mrs Weinstock ×2, 103 Jacob Weinstock, 104 Libby, 105
Mrs Brach, 108 Home HT812, 111 AIT Room, 112 Mrs. Glick).

### 3. "I have more phones than six" — and the count is genuinely honest

The PBX shows **~13 A plus SIP devices registered from the office IP
(24.187.220.38)** — 101, 102×2, 104, 105, 111, 112, rooms 502–505, doors
509/510 — while the scan of `192.168.0.0/24` saw only ONE of the provisioned
Yealinks. The others are almost certainly on a **separate phone network/VLAN
the PC cannot ARP into** — structural, not a scanner bug (a live host on the
same /24 appears in `arp -a` after the sweep whether or not it answers HTTP).
⛔ **Do not "fix" this by letting the desktop scan arbitrary subnets** — the
capability fence validates against the machine's own interfaces on purpose, and
cross-subnet ARP is impossible anyway.

What shipped instead: the `/discovered` response carries **`knownElsewhere`** —
the tenant's provisioned phones whose MACs the scan did not see — and the found
screen lists them ("already set up… may be plugged into a different network in
the building. They keep working as they are."). ⛔ **Context only: an unseen
record never becomes a phone row** (tested), so it can never enter the reset
ladder.

### The MAC display override

⛔ **The customer view carries the formatted MAC ON PURPOSE since 2026-08-25**
(`customerPhoneView.mac`, `formatMac` → `80:5E:C0:C8:9B:86`) — Izzy's explicit
instruction; it is the sticker under the handset, the one identifier a person
can check two identical phones against. The chaos guard that asserted `p.mac ===
undefined` ("mac leaked to the customer view") now asserts the opposite — mac
present AND formatted — while ip/state/provisioningUrl stay diagnostic-only.
⛔ `formatMac` UPPER-cases; a lowercase regex in the flipped guard failed the
first chaos run. Shown on the found, clearing and live rows (`.dps-mac`, mono).

### Proven / not proven

Proven: api desk-phone suites **94 pass** (routes 33 incl. 6 new, stress,
chaos, ordering, invariants), shared 94, portal driver 13; typechecks at
baseline (api **76**, portal **0**); the pm.model guard fails against HEAD; the
enrichment SQL replayed on the live PBX. ⏳ NOT PROVEN: nobody has pressed
"Search again" on the new build — acceptance is Izzy's next scan at A plus
center: the Yealink row should read **"Mrs Weinstock — ext 102 / yealink T42S /
80:5E:C0:C8:9B:86"** with her handset photo, the five Fanvils read "fanvil"
with MACs, and the "also set up" section lists the ~8 unseen provisioned
phones by name. ⛔ The desktop window must be fully closed and reopened first —
an open window keeps the old bundle.
