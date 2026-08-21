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
