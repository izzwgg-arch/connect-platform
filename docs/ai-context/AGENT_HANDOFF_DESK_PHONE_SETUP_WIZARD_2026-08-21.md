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
