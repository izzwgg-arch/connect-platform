# PLAN — make the desk-phone wizard finish phones itself, on any computer, prompting for what it needs (2026-09-10)

Written for the next session (any model) to execute end to end. Izzy's directive, verbatim intent:
*"I want the wizard to work properly and efficiently on everybody's computer in any situation. It should be able to set up the phones, not upgrade to Support. If there are any permissions the computer or the network needs, it should prompt the user. No PowerShell by the agent — an automated system."*

Read first: CLAUDE.md sections "desk-phone wizard", "PnP hands a reset phone its folder" (§20/§21 of
`AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md`), "Panasonic", and the four standing rules
(read MD first / update MD last / never propose a fix without tracing blast radius / a new page needs its toggles).

---

## 0. Ground truth — what is actually wrong today (proven, not inferred)

The stuck run is **Landau Home**, `DeskPhoneSetupRun cmtvj71qu0ap9o213v8y8t1dj`, created 2026-09-10 12:56Z, last write 13:59Z. On screen: **"0 of 3 phones ready"**. Four devices were found:

| MAC | IP | Vendor / model | State | Why |
|---|---|---|---|---|
| `80:5E:C0:B3:B2:D0` | 192.168.6.170 | Yealink | **NEEDS_ATTENTION, haltedReason=support** | "office machine could not hand the phone its provisioning folder over PnP (bounded restarts, then listen-only)" — the wizard did its hour, gave up |
| `C0:74:AD:8C:65:4E` | 192.168.6.171 | Grandstream GXP2170 | **ASSIGNED, "Preparing" forever** | `vendorSupportsLocalActions` is Yealink-only; the driver stalls 3× and stops; the server never gives a terminal decision |
| `C0:74:AD:8C:60:5F` | 192.168.6.172 | Grandstream (model blank) | **ASSIGNED, "Preparing" forever** | same |
| `C0:74:AD:E5:79:37` | 192.168.4.22 | Grandstream HT812 (ATA) | IDENTIFIED, skipped | user unticked it; note it is on 192.168.**4**.x while the PC is 192.168.**6**.x (Izzy's home is a /22) |

**Windows Firewall is NOT the blocker on this machine** (checked read-only): `loopcom.exe` has inbound **Allow** rules for TCP *and* UDP, all ports, Private+Public, no Block rule. So `cannot_listen` did not fire here. The listener bound; **the Yealink simply never announced itself inside the window** (restart never landed — a reset Yealink has HTTP off and asks at the handset before obeying an Action URI — and nobody power-cycled it while listening).

**The whole phoneSetup subsystem is SILENT in `connect.log`** — `registerPhoneSetup({ ipcMain, safeStorage })` in `apps/desktop/src/main.ts:844` passes no `log`, so `createPnpResident({ log: deps.log })` gets `undefined` and `run()` never logs. Zero lines all time. That is why this took a database read to diagnose. Fix it first (§2).

**This workstation has Tailscale, Hyper-V, Docker Desktop and WSL adapters.** `pnpResident.ts` calls `s.addMembership(PNP_MULTICAST_GROUP, iface)` with `iface = undefined` → the OS default interface. On a box with virtual NICs that can be the wrong one, so the phone's `SUBSCRIBE` to 224.0.1.75 is never heard even with the firewall open. Treat this as a likely contributor; §4 fixes it structurally rather than by testing one PC.

---

## 1. Non-negotiables for whoever builds this

- **No hand fixes.** Nothing gets "fixed" by the agent running commands on Izzy's PC, on the PBX, or in PowerShell. Every fix is product code. Diagnostics may read logs/DB read-only.
- **Read the four standing rules in CLAUDE.md.** Trace blast radius before every change (`git grep` every caller). Stage explicit paths, `git commit -F - -- <paths>`, never `git add -A`. Grep every staged diff for words you did not write.
- **Any new or changed wizard SCREEN needs a mockup Izzy approves BEFORE it is built**, then a published mockup-vs-built comparison (his standing rule; see the support-console section).
- **Desktop builds come from a clean `git archive` export with a junction, never in-tree** (electron-builder + the node_modules junction ships a broken asar — see the rc.10 section). Verify the asar's `node_modules` holds every electron-updater dependency before install. `verify-built-icon` must pass.
- **Publishing = fleet-wide auto-update** (the feed is on rc.10). Publishing is Izzy's call, every time.
- **"Fixed" means a real phone registered** — `pjsip show endpoint T<t>_<ext>` reading `Avail` on the PBX — never a green suite, never a container grep.
- **Source guards for every wiring change, replayed against HEAD** (every guard must fail on the pre-change tree). Tests must be REGISTERED in the package's explicit test list (desktop/portal/api all name files).
- **Update CLAUDE.md, the handoff doc and memory at the end**, and tell Izzy which files.

---

## 2. Phase A — make the subsystem observable (do this FIRST, it is ten lines)

`apps/desktop/src/main.ts:844`: pass `log: (line) => diag("phoneSetup", line)` into `registerPhoneSetup`, and thread it into `mainWiring.ts` → `createPnpResident({ log })` AND into `run()` so every op logs `op`, target ip, vendor, and the outcome (`ok` / `refused:<reason>`) — **never** packet contents, credentials, or the provisioning URL's folder hash.

Log, at minimum: resident armed (url host + MAC count), which interfaces joined the multicast group (§4), every `SUBSCRIBE` heard (MAC + whether it was on the armed list), every NOTIFY sent/acked, every `set_provisioning`/`discover`/`test_credentials`/`trigger_autop` call and result, and every firewall-permission step (§3).

Guard: a test that reads `main.ts` source and fails if `registerPhoneSetup` is called without `log`.

Why first: every later phase is only diagnosable with this in place, and it costs nothing.

---

## 3. Phase B — the app asks Windows for permission itself (Izzy's explicit ask)

Today the PnP listener relies on **Windows' own firewall popup**, which (a) needs an administrator, (b) can hide behind the wizard, and (c) if dismissed creates a **Block** rule that silently kills the feature forever. The per-user NSIS install cannot add a rule (no elevation). CLAUDE.md already names "an elevated firewall-rule step" as the durable fix. Build it.

**Mechanism (all inside the app, one UAC click from the user):**
1. New desktop capability op `ensure_network_permission` (name must match `^[a-z][a-z0-9_]{0,63}$`). It:
   - Checks whether inbound UDP 5060 to this exe is allowed — by attempting the bind AND by reading firewall state. Reading: spawn `netsh advfirewall firewall show rule name=all dir=in` (or `Get-NetFirewallApplicationFilter`) as a **non-elevated child process of the app** and parse for a rule whose program is this exe. A Block rule for the exe = "previously refused." (This is the app doing it, not a person in PowerShell — that is what Izzy asked for.)
   - If allowed → returns `{ ok: true, state: "allowed" }`.
   - If a Block rule exists or no Allow rule and the bind fails → returns `{ ok: false, state: "needs_permission" | "blocked_rule" }` **without** prompting; the WIZARD decides when to prompt (so the popup never appears out of context).
2. New op `request_network_permission`: launches an **elevated one-shot** — reuse the exact pattern in `apps/desktop/src/remoteSupport/` (`ElevatedInputInjector`: `Start-Process -Verb RunAs -Wait` + a one-time token over a named pipe) — that runs `netsh advfirewall firewall add rule name="Loopcom desk phone setup" dir=in action=allow program="<exe>" protocol=UDP localport=5060 profile=any enable=yes` and, if a Block rule for the exe exists, `delete`s it. Returns `{ ok: true }` on `ok elevated` + rule present, `{ ok: false, refused: "user_declined" | "not_admin" }` otherwise. A declined UAC is a **recorded refusal**, never a crash (the EPIPE lesson).
3. **Wizard step, before the first listen** (screen in §8): *"Loopcom needs Windows' permission to listen for your phones on this network"* → **Allow** button → UAC → continue. On refusal: plain English, a **Try again** button, and the phone stays in "waiting" (§5) — it does **not** halt to Support. A user who cannot elevate is told exactly that ("ask whoever manages this computer to click Allow") and the wizard keeps listening on whatever it *can* do.
4. `PnpResidentHost` (portal, `providers.tsx`) arms hourly. When the resident reports `problem: "cannot_listen"`, surface it in the Desk Phones page header as a one-line banner with the same Allow button — never silently.
5. **Fence:** the elevated helper accepts exactly ONE fixed rule shape (program = own exe, UDP, 5060, inbound, allow). No caller-supplied program path, port or action — it is not a general firewall tool. Source-guard it.

Also detect **port already in use** (another SIP app holding UDP 5060): distinct message ("another phone program on this computer is using the port — close it"), not "cannot listen".

---

## 4. Phase C — the listener works on any network (the multi-NIC fix)

`pnpResident.ts` binds `0.0.0.0:5060` and joins the multicast group on ONE interface (OS default). Make it:
- Enumerate every **private IPv4** interface (`os.networkInterfaces()`, skip loopback, link-local 169.254, Tailscale 100.64/10 CGNAT, Hyper-V/WSL/Docker vSwitches by name AND by subnet-not-containing-any-discovered-phone) and `addMembership(224.0.1.75, <ifaceAddr>)` on **each**. Log which joined.
- Prefer, and always include, any interface whose subnet contains a phone the wizard discovered or the PBX records for this tenant.
- Keep `reuseAddr: true`; on `EADDRINUSE` report "port in use" (§3), never `cannot_listen`.
- Answer with the local endpoint on the interface the SUBSCRIBE arrived on (`pickLocalAddressFor` already does this per-packet — keep it).
- **Subnet honesty:** if a phone's IP is not inside any interface's subnet on this PC (a VLAN'd office like A plus center), say so on that phone's row: *"This phone is on a different network than this computer, so the computer can't reach it directly"* — and route it to the server-side path (§7), not to an infinite spinner and not to Support.

Guard: unit tests with fake `os.networkInterfaces()` shapes (single NIC; NIC + Tailscale + Hyper-V; phone on the second NIC) proving the right set joins.

---

## 5. Phase D — Yealink: never halt while the listener is alive; power-cycle is THE step

Facts that stand: a factory-reset Yealink (a) ships with HTTP off and answers only 443, (b) on defaults **asks at the handset** before obeying an Action-URI restart from an unlisted address, (c) multicasts its PnP `SUBSCRIBE` **on every boot**. So the restart trick is unreliable by design and **the physical power-cycle is the mechanism**, not a fallback.

Changes:
- `set_provisioning` no longer counts "restart attempts" toward a give-up. It arms the resident with the MAC, tries the restart once (HTTP→HTTPS fallback already exists), and returns `listening` immediately.
- Server `advance` (`apps/api/src/deskPhoneSetup/*`, the `provisioningHandoffFailed` override): **remove the one-hour halt-to-support** for Yealink. The phone sits in a new customer-visible state *"Waiting for this phone — unplug its power and plug it back in"* for as long as the wizard is open, and the **standing resident finishes it whenever the phone announces**, wizard open or not. Halt to Support ONLY when: the machine genuinely cannot listen after the permission step was refused (§3), OR the phone is off-subnet (§4), OR three real power-cycles were observed (DHCP/ARP reappearance seen by the scanner) with no SUBSCRIBE heard — that last one means PnP is disabled on the phone (`static.auto_provision.pnp_enable=0`) and is a genuine Support case.
- The driver: a Yealink in "waiting" is polled, never `markStall`ed into silence; the row shows elapsed time and the last thing heard.
- On delivery (NOTIFY acked), the existing path continues (`/discovered` → `trigger_autop` → registration wait → REGISTERED). Nothing new after the handoff.

Acceptance on the rig: the Yealink at 192.168.6.170 — power-cycle it with the wizard open → app log shows `SUBSCRIBE heard 805ec0b3b2d0 (armed)` → NOTIFY acked → `T21_101` (Landau Home ext 101) reads `Avail` on the PBX. **That is the proof; nothing less.**

---

## 6. Phase E — Grandstream adapter (the real gap; Izzy has the rig on his LAN right now)

Grandstreams have **no Yealink-style PnP multicast**. A reset GXP/HT gets its settings from a **config server URL** set on the device (or DHCP option 66/43, or Grandstream's cloud — out of bounds like Yealink RPS). The automatable local path is the device's own **HTTP API on default `admin/admin`**: log in, set the config-server path + protocol to the PBX's provisioning folder, set the house rules, save, reboot. The PBX side already exists — `provisioning.brands` includes Grandstream and VitalPBX renders `<tenant-hash>/<mac>.cfg` for it (same writer the console proved for Yealink).

**Capture first, off the real devices** (per the repo rule: vendor config codes are never guessed): the GXP2170 at 192.168.6.171 and the HT812 at 192.168.4.22 are on Izzy's network. With his OK, exercise the device's web UI login + config POST and record the exact endpoints and P-codes for: config server path (`P237`-family on GXP, `P192`/`P237` on HT — VERIFY on the device), provisioning protocol (HTTPS), "accept incoming from SIP server only" (HT: `P1250`-family — VERIFY), timezone New York with DST, and reboot. Write them into `packages/shared/src/deskPhoneSetup/grandstream.ts` with the capture date and device firmware in the header. ⛔ A wrong P-code configures nothing silently — every code must be proven by re-reading it back from the device.

Then:
- `apps/desktop/src/phoneSetup/grandstream.ts`: adapter with `fingerprint` (already partly there via banner/OUI), `test_credentials`, `set_provisioning` (login → POST config → reboot), same private-address fence and scheme fallback as the Yealink adapter, credentials by reference only.
- `vendorSupportsLocalActions()` → true for `grandstream` **only once the adapter ships**, and only for the kinds captured (desk_phone GXP/GRP, ata HT). Doorbells (GDS) stay server-side until captured.
- Server `advance`: Grandstream gets the same "point it at the folder → wait for registration" ladder. **No factory reset on a Grandstream ever** without the same explicit approval card, and never on an HT (it erases the analog config).
- The HT house rules (`kindRequirements("ata")`: inbound from SIP server only, Eastern time) are **applied by the adapter at set-provisioning time AND in the PBX template** — both, guard-tested, because the template is what survives a reboot.

Acceptance: GXP2170 → registers as `T21_101` (or whatever Izzy assigns — today all four are mapped to ext 101 "Home", which is itself odd; ask him whether that is intended). HT812 → its analog port registers and an outside INVITE is refused.

---

## 7. Phase F — the server stops leaving phones in limbo

`advance` today: Yealink → hour → support; non-Yealink → no terminal decision → infinite "Preparing". Change to a per-vendor decision table:
- vendor with local adapter + on-subnet → local ladder (§5/§6);
- vendor with PBX template but no local adapter yet → state **"needs its settings pointed at Loopcom"** with plain-English instructions for that vendor + a Support button — a *finished* state, not a spinner;
- off-subnet → the §4 message + the same server-side instructions;
- Panasonic (no PBX brand) → existing halt, unchanged.
`summarizeRun` must count these terminal states so "N of M ready" is honest and the run can finish.

---

## 8. Phase G — wizard screens (MOCKUP FIRST, Izzy approves, then build)

Screens to draw: (1) the permission step (§3) with Allow / Try again / "ask your administrator" branches; (2) the per-phone "waiting — power-cycle it" row with elapsed time and last-heard; (3) the "different network" row; (4) the vendor "point it at Loopcom" row. Light + dark, `dps-*` classes, the existing `PermissionGate` and `workspace.desk_phones` key — no new page, so no new toggles; if a new PAGE is added, it needs its nav entry + both permission editors in the same commit.

---

## 9. Phase H — tests and guards (all registered, all replayed against HEAD)

Desktop: resident multi-interface join; port-in-use vs cannot-listen; permission ops (fake spawn, fake elevated pipe) incl. declined UAC; Grandstream adapter against captured fixtures; the firewall-rule shape fence. Portal: driver never stalls a "waiting" Yealink; screens' source guards. API: advance decision table (exhaustive over vendor × subnet × listener state — extend the existing 12.6M-decision invariant suite's shape), no infinite Preparing, no halt while listening. Shared: `vendorSupportsLocalActions` truth table.

---

## 10. Phase I — build, deploy, publish (in this order, with the traps)

1. api + portal via `deploy-direct.sh` (dry-run first; poll `ps -eo cmd | grep -E "[d]eploy-(direct|portal|api)"` — the heavy-build lock is real).
2. Desktop: clean export build (rc.10 recipe), asar dep check, `verify-built-icon`, install on **Izzy's PC first** with `/S`, restart the app, confirm `[phoneSetup]` lines appear in `connect.log` (Phase A proof).
3. Run the acceptance in §11 on his rig.
4. Only then, on Izzy's word, publish `Connect-Setup-latest.exe` + flip `latest.yml` (fleet auto-updates within ~3 h).

---

## 11. Acceptance — on Izzy's real rig, watched, not inferred

1. Open Desk Phones on the rc.11 app → permission step appears only if needed (on this PC it should NOT — rules already exist; that negative matters).
2. Yealink 192.168.6.170: row reads "waiting — unplug and plug back in"; power-cycle; within ~60 s row flips to Restarting → Ready; PBX `pjsip show endpoint T21_101` = `Avail`; `connect.log` has the SUBSCRIBE/NOTIFY lines.
3. GXP2170 and the second Grandstream: rows go Preparing → Restarting → Ready; both register.
4. HT812 (192.168.4.22): tick it; it registers; an INVITE from a non-PBX source is refused.
5. Negatives: a phone NOT on the armed list is never answered (log shows "heard, not armed"); closing the wizard mid-wait does not stop the resident; a declined UAC leaves the phone waiting with the honest message and nothing crashes.

---

## 12. Decisions that are Izzy's (ask, do not assume)

- OK to log in to the GXP2170/HT812 web UIs on his LAN with default creds to capture the config API? (Needed for §6.)
- All four devices are assigned to ext 101 "Home" — intended, or should each get its own extension?
- Publish to the fleet after the rig passes, or hold?
- Should the permission step also cover macOS later (not in scope now)?

## 13. MD to update at the end
CLAUDE.md (new ⛔ section + correct the "§20/§21" bullets), `AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md` (new §), memory: `yealink-pnp-hands-a-reset-phone-its-folder.md` (power-cycle is the mechanism; no hour halt), new `grandstream-adapter-captured-off-real-devices.md`, new `app-asks-windows-for-firewall-permission.md`.

---

## 14. DONE 2026-09-10 — the vendor catalogue and an adapter for every one of the 427 models

Commits `830101a8` + `a98a70f1` on `feat/ivr-migration-takeover`, pushed.
**Shared package only — nothing is wired into the wizard, the desktop app or the server yet, and
nothing is deployed.** Proof page for Izzy:
<https://claude.ai/code/artifact/c233fc3a-fa7e-469b-a879-5304a2bda80f>

Izzy's scope, final and verbatim: *"it doesn't matter. It's for the future as well. Every single
phone should be able to be provisioned automatically through the automatic wizard, so every single
phone needs to have an adapter, and the template should be connected to it. all 427 should have"* —
plus *"I want you to come back with proof to me that every single one has an adapter."*

### 14a. What shipped

Two layers, deliberately separated, because they answer different questions and one of them must
never be edited by hand.

- **`packages/shared/src/deskPhoneSetup/vendorCatalog.generated.ts`** — the PBX's own truth.
  20 brands, **427 models** with their `provisioning.phone_models.id`, **1,143 OUI prefixes**, the
  `provisioning_path` key each brand's template writes, and **per model** two independent facts:
  `hasBaseTemplate` and `templateWritesProvisioningPath`.
- **`scripts/deskPhoneSetup/gen-vendor-catalog.py`** + `data/` — the generator and the three
  read-only dumps it reads. Re-run it and the catalogue regenerates byte-identically; it asserts
  its own invariants and **refuses to write** if the PBX's data has moved (see 14c).
- **`packages/shared/src/deskPhoneSetup/vendorAdapters.ts`** — the hand-written half. Per brand:
  the OEM where the box lies about who built it, the mechanisms **in the order the driver should
  try them**, the PnP profile, default credentials, the literal HTTP paths that reboot / re-read /
  set the URL, DHCP options, config filenames, a **confidence**, and a **gaps** list in plain words.
- **`packages/shared/src/deskPhoneSetup/vendorCoverage.test.ts`** — 17 checks, registered in
  `packages/shared/package.json`. Shared suite 597/597, typecheck 0.

### 14b. THE RULE the adapter file exists to protect

`confidence` is `proven | documented | inferred | unknown`, and **`proven` means somebody watched
it work on a real handset on this platform**. Today that is **Yealink alone**. The test pins the
proven set to exactly `["yealink"]`, forbids a `proven` HTTP endpoint sitting on an unproven brand,
and fails any unproven adapter that lists no gaps. **A label cannot be upgraded without changing
that test in the same commit as the evidence.**

⛔ And none of it changes the older rule: a phone is Ready because **Asterisk says it registered**,
never because an adapter step returned success.

### 14c. ⛔ Four gaps the reconciliation found — named in code, not averaged away

Reconciling `provisioning.phone_models` against `base_templates/` **in both directions** is what
surfaced these. The generator hard-codes the known set and **throws if it changes**, so the gap can
never widen silently.

1. **`Gigaset P820 IP PRO` (id 407) has a catalogue row and NO template on disk.** Its neighbours
   p810 / p810b / p825 / p850w all have one. So it is **426 of 427 renderable, not 427**. Fixing it
   is one folder on the PBX and is Izzy's call.
2. **`base_templates/atcom/a20/` matches no catalogue row** (99 KB, dated 2024). Unreachable from
   the database side — nothing can ever be pointed at it. The DB has a20lte/a20w/a20wac but no
   plain a20.
3. **`0c383e` is registered to BOTH Fanvil and Attimo.** That is the strongest evidence we have
   that Attimo is a Fanvil rebrand, and it means a MAC can never name which. `vendorsForMac`
   returns **both**; `vendorForMac` returns **null** rather than choosing.
4. **Two manufacturer OUI blocks are missing from `provisioning.brand_macs`:** Flyingvoice's own
   `789912` (registered 2024 — the table only holds `0021f2`, the Easy3Call ODM block on older
   stock) and Snom's second block `1c7126`. **Current-production stock of either brand is not
   recognised by MAC at all.** Two rows, no code.

### 14d. The numbers, and what each one means

| | |
|---|---|
| Models in the catalogue | **427** across 20 brands |
| Models with an adapter | **427** — checked by walking the catalogue |
| Models the PBX can render | **426** (gap 1 above) |
| Templates that also write the URL back | **359** — the other 67 are pointed once and remember it |
| Models drivable from the office LAN | **396** |
| Models whose brand answers the boot-time multicast | **369** |
| Proven on a real handset | **82** (Yealink) |
| Documented by the manufacturer | **333** across 14 brands |
| Inferred from the template dialect | **10** (Attimo 4, ClearlyIP 3, LVSwitches 3) |
| Nothing published | **2** (Nurivoice 1, Hanyang Digitech 1) |

⛔ **"Template does not write the URL" is NOT "cannot be provisioned"** — they are separate stored
fields for a reason. All 17 Aastra-Mitel models are in that group, which is exactly why that
brand's `templateProvisioningKey` is `null`. Also in it: the 23 older Polycom SoundPoint/Edge
models, the 7 Dinstar DAG gateways, 6 Gigaset DECT bases, 13 Sangoma A/D/P, 1 Snom DECT base.

⛔ **31 models across four brands (Alcatel-Lucent 15, Dinstar 14, Nurivoice 1, Hanyang 1) have no
mechanism a computer on the LAN can drive at all.** `hasLocallyDrivableMechanism()` is what the
wizard must consult **before it shows a progress bar** — the alternative is pretending to work on
a phone we cannot touch. The test pins that list.

### 14e. What the research established (five agents)

The single most useful finding: **one PnP responder covers most of the fleet.** Yealink, Snom,
VTech ET6xx, Fanvil, Htek, Sangoma S-series, Atcom, Flyingvoice, Gigaset and (inferred) Attimo all
send a SIP `SUBSCRIBE` for `Event: ua-profile` to **224.0.1.75:5060** at boot and obey a `NOTIFY`
carrying `Content-Type: application/url` with the URL as the body — 369 of the 427 models.

⛔ **The `Event` header cannot identify the model.** Snom and VTech both send `vendor="OEM"
model="OEM"`; Fanvil sends `vendor="Fanvil" model="VOIP PHONE"`; Atcom sends `vendor="ATCOM"
model="ATCOM"`. **Recognise the brand by OUI, not by the SUBSCRIBE.**

Per-brand facts worth not re-deriving:

- **Htek is the OEM behind the Sangoma S-series** (its MACs are Hanlong's `001fc1`) and behind
  ClearlyIP (identical `P237` template key). Action URI `GET /Phone_ActionURL&key=Reboot|AutoP`,
  admin/admin.
- **Sangoma is two unrelated platforms in one brand.** S-series = Htek. A/D/P-series = Sangoma's
  own (Digium heritage): **mDNS `_digiumproxy._udp`**, SIP NOTIFY `check-sync`, `<mac>.cfg`,
  password **789** not admin — and ⛔ **its web UI locks once provisioned; only a factory reset
  gets it back.**
- **Gigaset reads DHCP option 114, not 66.** A network configured for every other brand will not
  reach it. No HTTP API at all.
- **Atcom's action URI is NOT a cold-start lever** — it is gated by the phone's own caller
  allow-list, and the first request from an unlisted address makes the **handset** ask a person to
  allow remote control. PnP is the only cold path. There is no `AutoP` key; REBOOT is the only one.
- **Flyingvoice is a hybrid**: Yealink's exact filename scheme (`<mac>.boot`, `y000000000000.cfg`,
  with a published fetch order) with Fanvil's action-URI path (`/cgi-bin/ConfigManApp.com?key=AutoP`
  — and `AutoP` there needs **no reboot**). Also honours SIP NOTIFY `check-sync;reboot=true`.
- **Fanvil has no documented HTTP call that SETS the URL** — only reboot / re-read. The URL must
  arrive by PnP or DHCP.
- **Grandstream randomises the admin password on a sticker** on everything built since 2017, so its
  HTTP paths need the customer to read it off the phone. Sources disagree on port (5060 vs 5080)
  and content type (`application/url` vs `application/x-gs-ucm-url`) — **the listener must accept
  both rather than pick one.**
- **Polycom UCS 5.9.7 and later force the `456` password to change at first login**, so a phone
  that has ever been switched on may refuse the factory credentials.
- **Cisco MPP usually ships with web administration disabled**; the SPA generation's
  `GET /admin/resync?<url>` both points and fetches in one request.
- **Attimo is almost certainly a Fanvil rebrand** — a Brazilian operator that brands hardware
  rather than building it; its PBX template writes Fanvil's own `Flash Server IP` key, and the PBX
  gives it Fanvil's OUI.

⛔ **Cross-check that validated everything:** the PBX's own `brand_macs` table agrees with the
manufacturers' IEEE registrations on every block the research checked — `808287` Atcom, `001fc1`
Htek, `0c383e` Fanvil, `005058` Sangoma, `000413` Snom, `7c2f80` Gigaset, `0021f2` Flyingvoice's
ODM block. Two independent sources, same answer.

### 14f. Traps paid for while building this

- ⛔ **`provisioning.brand_macs` mixes formats.** Most rows are bare 6-hex; the rows added later
  carry colons (`EC:74:D7`); two ClearlyIP rows are IEEE **MA-M/MA-S** assignments **7 and 9 hex
  digits long**. Normalise to lowercase hex with no separators and match by **prefix**, or 10 rows
  are silently dropped and two brands stop being recognised.
- ⛔ **Bash heredocs here turn an escaped newline inside a Python string into a REAL newline**,
  which produced an unterminated string literal and a half-patched generator that ran clean and
  wrote nothing new. Write any file containing escapes with the editor, never a heredoc. It bit
  again writing this very section, on the content's own quoting.
- ⛔ **A generator that "succeeds" is not a generator that wrote what you asked.** The first patched
  version printed its success line while three of its writer edits had silently failed to apply —
  caught only by grepping the OUTPUT for the new field.
- ⛔ The template scan must count **models**, not template directories: `base_templates` also holds
  the `atcom/a20` orphan, which writes `provisioning_path` and belongs to no catalogue row. That
  one row is the difference between 360 and 359.
- ⛔ `git commit -F - -- <paths>` commits **only** the paths in the pathspec. Two modified files
  were left behind by the first commit and needed a second one — check `git status` after.
- ⛔ The in-app Browser pane cannot render a `file://` page and cannot sign in to claude.ai. It is
  also the documented Claude-Desktop crasher — use `mcp__claude-in-chrome__*`. I reached for the
  pane first here; the rule is at the top of CLAUDE.md and I should not have.

### 14g. NOT DONE — what still stands between this and Izzy's actual ask

The catalogue and the adapters exist and are proven as data. **Nothing consumes them yet.**

1. The `VendorAdapter` interface is not wired into `apps/desktop/src/phoneSetup/` — `yealink.ts` is
   still the only executor, and the desktop cannot import the monorepo, so it needs a
   drift-guarded copy the way `coworker/policyCore.ts` does.
2. `pnpResident.ts` still joins the multicast group on the **OS default interface only** and still
   assumes Yealink's port and content type. Multi-NIC and Grandstream tolerance are Phase C/E.
3. `vendorSupportsLocalActions()` in `deviceKinds.ts` still returns true **only for Yealink**, so
   every other brand still stalls in "Preparing" — the original defect Izzy reported.
4. The server ladder still halts to Support after about an hour on `provisioningHandoffFailed`, and
   has no per-vendor decision table.
5. Nothing writes a `provisioning.devices` row per model yet (`save_phone` exists; the wizard does
   not call it), and the no-MAC common files (Polycom `000000000000.cfg`) do not exist per tenant.
6. Phases A and B of this plan — the log wiring and the in-app firewall prompt — are untouched.

---

## 15. IN PROGRESS 2026-09-10 evening — Izzy's flow, Phase A and the honest finish

Commits `731e04c0` + `3e21ceec` on `feat/ivr-migration-takeover`, pushed.
**Desktop + portal source only. NOTHING IS DEPLOYED and no desktop build exists**,
so Izzy's stuck Yealink is unchanged on his screen.

Izzy's scope this session, verbatim intent: *"Do you know the model of the phone?"*
with a **manufacturer dropdown from our database** feeding the search; discovery that
covers **PoE switches, Wi-Fi extenders, anywhere a phone can be**; select → assign to
an extension → Next; **"Preparing means all phones are factory reset"**; prompt for
any Windows/network permission; *"rock hard, solid in any situation… sustainable for
long-term high usage in the years to come."*

⛔⛔ **THE CONSENT MODEL IS THE TICK, AND HE CORRECTED ME ON IT.** I flagged
"Preparing = factory reset all phones" as dangerous. His answer: the tick on the
found screen IS the permission — *"as long as the customer unchecks that box, that
phone does not get factory reset. Only the checkboxes of the phones the customer
checks to be connected to Loopcom get factory reset."* So there is **no separate
approval card**; the found screen says plainly that ticking wipes the phone, and
`resetAuth` collapses into the selection. Build it that way.

### 15a. Mockup awaiting approval
<https://claude.ai/code/artifact/f5047981-e442-482a-9cdd-315670161f73> — seven screens
at the wizard's real 760px width in the app's own `dps-*` tokens, light and dark.
⛔ Four decisions are his and are NOT assumed (listed in §15e).

### 15b. Shipped: the subsystem can say what it did (`731e04c0`)
⛔⛔ **IT WAS SILENT FOR ITS WHOLE LIFE.** `main.ts:844` called
`registerPhoneSetup({ ipcMain, safeStorage })` with no `log`, so
`createPnpResident({ log: deps.log })` got `undefined` and `connect.log` held **zero**
phoneSetup lines, ever. That is why the stuck run needed a production DB read to
diagnose. Now: main.ts passes `diag("phoneSetup", …)`, mainWiring threads it to BOTH
the resident and the capability, and the capability logs from **ONE wrapper around
the dispatcher** (`run` → `runInner`) rather than at its twenty return paths — a new
op, or a new refusal on an old one, cannot be silent.
⛔ `describeRequest` reduces a provisioning URL to its **HOST**: the path carries the
16-hex tenant folder hash, which is the credential a phone uses to fetch its own SIP
password, and a log file is something a customer opens and pastes into a ticket.

### 15c. Shipped: it sweeps every network (`731e04c0`)
⛔⛔ **`scanLan` TOOK `subnets[0]` AND WROTE A NOTE ABOUT ITS OWN BUG** — *"This
computer is on N networks; only X was scanned."* A PC with a cable and Wi-Fi, or one
behind an extender handing out a second range, missed the other network in silence.
Now `localScannableNetworks()` returns all of them with adapter names, `scanLan`
sweeps every one **smallest first**, merges by MAC, under a **3,000-address budget
across all networks combined**, and a network too big to fit is **NAMED** in the note.
⛔ `subnet` keeps its old meaning (the first swept) because the portal stores it on the
run; the new `subnets: ScannedNetwork[]` is the whole truth for the screen.
⛔ **Virtual adapters are filtered by NAME as well as range** — Hyper-V, WSL and Docker
all sit in 172.16–172.31, which IS RFC1918, so the private-address test admitted them.
✅ **Measured on Izzy's real machine:** Tailscale, the Hyper-V switch and loopback are
correctly dropped, leaving one Wi-Fi **192.168.4.0/22** (1,022 addresses) — which spans
.4.0–.7.255 and therefore already covered **all four** of his phones.
⛔⛔ **SO MULTI-NETWORK IS NOT WHAT BROKE HIS YEALINK.** Say so plainly; it matters for
other offices, not for that run.

### 15d. Shipped: the finish screen stops lying (`3e21ceec`)
His screen showed a **green tick** above **"0 of your 1 phones are ready"** with
*"Your office is working."* beneath it. `summarizeRun` was honest (ready 0,
needsAttention 1) — the JSX drew the tick **unconditionally** and branched its sentence
on `needsAttention` alone, so "nothing connected" and "one of six still to do"
rendered identically. Three outcomes, three marks now; the word "working" is printed
only when at least one phone is.

### 15e. ⛔ STILL BLOCKING — four of these are Izzy's, and two of them gate real work
1. **Approve the mockup**, or say what to change. The manufacturer dropdown, the
   whole-network search screen and the tick-wording all wait on it.
2. **May the agent sign in to the GXP2170 (192.168.6.171) and HT812 (192.168.4.22)
   with default credentials to capture the real config API?** Phase E cannot be built
   from guesswork — a wrong P-code configures nothing, silently.
3. **Do the two middle screens come out?** He said "click Next and it searches", which
   skips today's `connection` (cable/Wi-Fi) and `network` (explainer) steps. Neither
   changes what is scanned. Drawn as removed in the mockup.
4. **All four devices are assigned to ext 101 "Home"** — intended?

### 15f. ⛔ NOT DONE — and the honest reason for each
- **`vendorSupportsLocalActions` is still Yealink-only, DELIBERATELY.** Flipping it for
  Grandstream today would be **worse than the stall**: `capability.ts` imports only
  `yealink.ts`, so the driver would point Yealink-shaped HTTP at a Grandstream. The
  adapter must exist first (needs decision 2).
- **The Yealink is still halted.** The `provisioningHandoffFailed` override still
  converts `set_provisioning` into a halt-to-Support after the bounded restarts.
  ⛔ Removing that override alone is NOT the fix — it exists because every further
  `set_provisioning` restarts somebody's phone again. The plan's §5 shape (stop
  counting restarts, enter a WAITING state the standing resident finishes) needs the
  server AND driver changed together.
- **Grandstreams still stall in "Preparing"** — no terminal decision exists for a
  vendor with a PBX template and no local adapter (plan §7).
- **The permission prompt (plan §3) is untouched.**
- **Nothing is deployed and no desktop build exists.** The portal fix reaches nobody
  until a portal deploy; the desktop fixes need a clean-export build (rc.11) installed
  on his PC, and publishing auto-updates the fleet — his call, every time.

---

## 16. DONE 2026-09-10 — the Grandstream capture, taken from the device AND from our own PBX

Phase E said *"a wrong P-code configures nothing, silently"* and demanded the codes be
proven. They now are — twice over, from two independent sources that agree.

### 16a. Where the codes came from (so nobody guesses one again)

⛔⛔ **`GET /cgi-bin/metaconfig_get` on a Grandstream answers UNAUTHENTICATED with the
handset's own alias→P-code map.** On Izzy's GXP2170 (192.168.6.171) that is **2,632
entries** — the authoritative dictionary, straight off the device, no login, no password,
no sticker. This is the mechanism to use for ANY Grandstream model, present or future.
Anything else is guessing.

⛔ **`GET /cgi-bin/api.values.get?request=phone_model` is also unauthenticated** and
returns `GXP2170`. A credential-free fingerprint — which matters precisely because
Grandstream randomises the admin password onto a sticker nobody has read yet.
⚠️ It echoes back ANY key you ask for with an empty value, so only a NON-EMPTY answer
means anything; `token`, `login_token` and friends all come back `""`.

The provisioning codes, read off the device with their real validation rules:

| P-code | Alias | Rules / default |
|---|---|---|
| **P237** | `provisioning.config.serverPath` | `min:0\|max:512`, default `fm.grandstream.com/gs` |
| **P212** | `provisioning.config.protocol` | `required\|include:"TFTP","HTTP","HTTPS","FTP","FTPS"` |
| P234 / P235 | config file prefix / postfix | `min:0\|max:512`, default `""` |
| P192 | `provisioning.firmware.serverPath` | |
| P194 | `provisioning.auto.mode` | `"No","YesUpgradeMin","YesUpgradeHourOfDay","YesUpgradeDayOfWeek"` |
| P1360 / P1361 | config username / password | |
| P22421 | `provision.config.forceReboot` | `integer\|between:0,1` |
| P145 | `provisioning.override.dhcp.allowCommonOptions` | `"Yes","No"`, default Yes |
| P8337 | `provisioning.override.dhcp.allowCustomOption` | `"None","Option150","Option160"` |
| P240 | `authenticateFile` · P1359 `filePassword` · P8467 `processAll.enable` | |

### 16b. ⛔⛔ TWO FACTS THAT WOULD EACH HAVE SILENTLY BROKEN A HAND-BUILT ADAPTER

**1. P237 IS NOT A URL.** Our own PBX renders it as
`209.145.60.79/phoneprov/<tenant-hash>` — **no scheme, no trailing slash** — and puts the
transport in **P212 as a separate value**. A Yealink-shaped `https://…/` written into P237
configures nothing. The two vendors are completely different in shape and the Yealink
adapter is not a model for this one.

**2. The two surfaces DISAGREE about P212's type.** The **config file** takes an
**integer** (`<P212>2</P212>`, and the template's own comment says 0 TFTP, 1 HTTP,
2 HTTPS, 3 FTP, 4 FTPS) while the phone's **metaconfig** declares the **strings**
`"TFTP"…"FTPS"`. A value correct for one surface is silently wrong on the other.

### 16c. ✅ The PBX ALREADY generates the file — Izzy's HT flow needs no new machinery

Izzy, 2026-09-10: *"the HT Grandstream, all HTs, usually are not done via URL. It's done
via an actual config file. Upload the file inside the UI, and it provisions."* and *"once
the MAC address is added to the PBX, the PBX generates a config file. We can test it there
and see what the PBX generates."*

Read-only on the live PBX, and it is all already there:

- Templates ship for **60 Grandstream models including `gxp2170` AND `ht812`**
  (`/var/lib/vitalpbx/provisioning/base_templates/grandstream/<model>/template.cfg`).
- Both are **Grandstream XML** (`<gs_provision><config>…`), rendered through a Blade-style
  template — NOT the flat `P237=value` format.
- **Seven Grandstream devices are already provisioned on this PBX**: 2× GXP2170, 2× HT801,
  2× HT802, **1× HT812**. So the file Izzy describes has been generated for real.
- ⛔ **The filename is `cfg<MAC>.xml`**, not Yealink's `<mac>.cfg`.
- The rendered HT812 file carries exactly:
  `<P212>2</P212>`, `<P237>209.145.60.79/phoneprov/f3df739ac62197cd</P237>`,
  `<P192>209.145.60.79/firmwares/HT812</P192>`, `<P234></P234>`, `<P235></P235>`,
  `<P145>1</P145>`, `<P8337>0</P8337>`, `<P8467>0</P8467>`, `<P240>0</P240>`.
- ✅✅ **PROVEN SERVED:** `https://209.145.60.79/phoneprov/f3df739ac62197cd/cfgc074ade57937.xml`
  answers **200 with 118,646 bytes — byte-identical to the file on disk.**

**So the whole HT mechanism is: MAC → PBX renders `cfg<MAC>.xml` → the file carries the SIP
account AND points P237/P212 back at the same folder → upload it once in the device UI →
it provisions and STAYS provisioned.** Nothing new has to be built to make that work; what
is missing is only the wizard step that fetches the file and tells the person to upload it.

### 16d. What is still NOT proven

- ⛔ **The WRITE has never been exercised.** `POST /cgi-bin/dologin` was reached on the real
  GXP2170 but not passed — it needs the sticker password, which nobody has read. So
  `api.values.post` stays **documented, not proven**; the P-codes it would carry ARE proven.
  ⚠️ Do not brute-force it: Grandstream locks out on repeated failures.
- ⛔ **The HT812 was NOT touched**, per Izzy's explicit instruction ("you could log into the
  GXP2170, but not the HT812"). Everything above about HTs came from the PBX, not the device.
- The adapter's `confidence` stays `documented`. It becomes `proven` when somebody watches a
  Grandstream take its config on this platform — not before.

### 16e. Recorded in code

`packages/shared/src/deskPhoneSetup/vendorAdapters.ts` — the Grandstream entry now carries
both traps in its `notes`, the proven filename order in `configFilenames`, the unexercised
write in `gaps`, and `metaconfig_get` as the way to re-derive any code. Shared typecheck 0,
`vendorCoverage.test.ts` 17/17.

---

## 17. DONE 2026-09-10 — Izzy's mockup exception (the photos) and the make dropdown

Izzy, 2026-09-10: *"The mockup is approved with one exception: the photos of the phone
are supposed to be next to the phone. Once the phones are identified, it should be a
photo there."* and, from the build request, *"there should be a dropdown first with all
manufacturers from our database."*

### 17a. ⛔⛔ The photo was never missing — the FALLBACK was lying

`PhonePhoto` has rendered the PBX's product image on all four screens since 2026-08-25.
What went wrong is what happens when there ISN'T one, and it is not a rare case:

**94 of the PBX's 427 models ship no product image (22%), measured on the live PBX.** Not
a random 94 — **every Grandstream HT and every Dinstar DAG**, i.e. the whole ATA family,
plus all 39 newer Polycom and 33 Flying Voice models. And **5 of the 7 Grandstream devices
provisioned on this platform today are HTs**, so for Grandstream a missing photo is the
COMMON case. Izzy's own two devices split exactly this way: the GXP2170 has a picture,
the **HT812 does not and never will**.

The old fallback drew ONE telephone glyph for all of them — pointing a customer at a phone
that is not on their shelf. `KindGlyph` now draws what the thing actually IS: a flat box
with sockets for an ATA, a cradle with an aerial for a cordless base, a cone with sound
arcs for a ceiling speaker, a wall panel with a call button for a door intercom, and — for
something we could not identify — **a plain box, because drawing a telephone would be a
claim**. The words already worked this way (`describe()` → `describeKind`); the picture
now agrees with them.

⛔ Verified against real models: `HT812`/`HT801` → `ata` → "Small box your regular phones
plug into"; `GXP2170` → `desk_phone`; `i64` → `doorbell`.

### 17b. The make dropdown — and the one way it must never be used

`BRAND_OPTIONS` is built from **VENDOR_CATALOG**, never typed into the component: a make
we have no template for must not be offered (they would pick it, we would find nothing,
and the wizard would look broken), and a make the PBX gains later has to appear without
anybody editing the file. It is a `ConnectSelect` (the portal's only dropdown), searchable,
with **"I am not sure — look for all of them" always present and last**.

⛔⛔ **THE MAKE ORDERS THE FOUND LIST AND NEVER FILTERS IT** (`makeHint.ts`). Reading the
wrong name off a sticker is an ordinary mistake — labels are small and offices have mixed
estates. If we filtered, that mistake would show an EMPTY found screen while their phone
sat right there in the scan results, and the only conclusion available to them is that the
wizard does not work. This is exercised, not grepped: `orderPhonesByMake` is driven with a
make that matches nothing and asserted to return all four phones.

### 17c. ⏳ The gap that is left, stated rather than guessed at

**76 of 427 models have no photo AND no kind**, so they get the plain box and the words
"Phone equipment". Overwhelmingly Polycom VVX/CCX/IP/E/B (39) and Flying Voice P-series
(33). `deviceKindFor` was written for the brands the wizard had met, and **300 of 427
models resolve to `unknown`** — 70%.

⛔ **Deliberately NOT fixed by pattern-guessing.** A wrong kind tells a customer the wrong
thing about hardware in front of them, which is worse than an unspecific one; `unknown`
→ plain box is honest. The one family added here is **`DAG\d` → ata**, because "Dinstar
Analog Gateway" is the product line's own name and all seven of them also lack a photo
(83 → 76). Closing the rest properly means sourcing a kind per brand — its own pass.

### 17d. Proven as

Portal typecheck **0**; portal suite **583 tests, 579 pass, 4 fail — the exact documented
baseline**, none in a file this touched (`campaignsIndexLayout`, `coworkerHands`,
`nativeSelectSweep` catching another session's `OrdersDesk.tsx`, `webrtcSdpDiagnostics`).
Shared **597/597**, shared typecheck 0. New `wizardMakeAndPhotos.test.ts` (registered)
**17/17**, and ⛔ **all 6 of its source guards FAIL replayed against HEAD** — including one
that had to be tightened because it passed at HEAD by slicing on a `KindGlyph` that did
not exist there, i.e. it was decoration until the replay caught it.

⛔ One existing guard was relaxed rather than worked around: `deskPhoneWizard.test.ts`
pinned `(step === "found" ? phones : chosen).map` byte-for-byte. Its stated intent —
"match, ready, live and done are about the CHOSEN phones only" — is untouched by an
ordering, so it now accepts either spelling AND gained a new assertion that the found
branch must never become a `.filter`.

⏳ **NOT PROVEN: nobody has opened the wizard in a browser since this.** It is proven as
typecheck, tests and measurements against the live PBX — never as a person looking at the
screen. Nothing is deployed.

## 18. DONE 2026-09-11 — the wizard stopped being a Yealink wizard (`dac3aab2`)

Izzy: *"Keep going. We need to get this up and running end to end. Every single phone
should be able to be connected through the wizard, all 427. I'm going to run a live test
again on my network."*

**api + portal DEPLOYED and container-verified; the desktop half is committed and rides
the next installer.** No migration, no PBX write, no env change, no tenant row touched.

### 18a. The finding: it was FOUR gates, not a missing adapter

§14 built an adapter for all 427 models and recorded that **nothing consumed them yet**.
The obvious next step looked like "write a Grandstream executor". It was not. A census of
the catalogue — measured, not assumed — says:

- **369 of the 427 models are on brands that send a PnP `SUBSCRIBE`, and every one of them
  sends the IDENTICAL shape**: `Event: ua-profile` to `224.0.1.75`, port **5060**, body
  `application/url`. Ten brands. There is nothing per-vendor to get right.
- **396 of 427 are drivable from the LAN by SOME mechanism.**
- **31 across four brands publish none at all** (Alcatel-Lucent 15, Dinstar 14, Nurivoice
  1, Hanyang 1). ⛔ Dinstar has **no OUI rows in the catalogue at all**, so a Dinstar box
  cannot even be named by hardware address.

So the wire protocol already covered most of the fleet. What stopped it was four gates
shaped around one vendor, each of which had to be opened separately.

### 18b. Gate 1 — one gate answered two different questions

`vendorSupportsLocalActions` returned true for **Yealink alone**, and
`setupDriver.ts` used that one boolean to refuse **everything** for every other brand —
including `set_provisioning`, whose entire local half is *opening a socket and waiting*.

⛔ **Its own rationale was about Action URI**, i.e. about **speaking** to a phone. It was
then used to decide **listening**, which is a different question with a different answer.
That conflation is the whole defect, and it is why a Grandstream sat on "Preparing".

Split, in `vendorAdapters.ts`, beside the data that answers them:

- **`vendorSupportsHttpActions`** — may this machine send an HTTP request *at* the phone?
  Backed by `VENDORS_WITH_A_SHIPPED_HTTP_EXECUTOR`, today `["yealink"]`. ⛔ An
  **unidentified** device answers **false**: talking to a device we cannot name is a guess,
  and pointing Yealink shapes at a Grandstream configures nothing while looking like it
  worked.
- **`vendorSupportsPnpHandoff`** — may this machine *answer* the phone? ⛔ An unidentified
  device answers **true** — it fails **toward listening**. Arming the responder for one
  costs a hardware address on a listener that answers nothing else; a device that is not a
  PnP phone simply never asks. **A locked phone from a previous provider reports no vendor
  at all, and that is precisely the phone this wizard exists for.**
- **`vendorCanBeDrivenLocally`** — the OR of the two, and only ever used to choose between
  a progress bar and an honest hand-off. `deviceKinds.ts`'s `vendorSupportsLocalActions`
  now delegates to it and its comment says it is a SUMMARY, not a policy.

In the driver: `rediscover` moved **above** the gate and is ungated (it is a network sweep,
not a request at a phone); the three HTTP ops stall when `!canHttp`; `set_provisioning`
stalls only when `!canPnp`; and the restart is `canHttp && attempts < 2`, so a brand whose
HTTP shapes we do not hold gets the listener armed and the person asked to power-cycle —
which is the documented mechanism for a factory-reset phone anyway.

### 18c. Gate 2 — the hardware-address list was 12 prefixes for 4 makers

`deviceIdentity.ts`'s `VENDOR_PREFIXES` knew yealink, grandstream, fanvil and panasonic.
The PBX's own `brand_macs` table holds **1,143 prefixes across 20 brands**. So a Polycom, a
Snom, an Htek, an Atcom, a Sangoma came back `unknown` — and `discoveryFilter.looksLikePhone`
then filed a real desk phone under **"other devices we left alone"**, so it never reached
the found screen and nothing downstream ever got the chance to set it up.

`guessVendorFromMac` reads `vendorsForMac` (the catalogue) first; `VENDOR_PREFIXES` is now
a **three-entry supplement** for what the PBX table is missing — Flyingvoice's own `789912`
and Snom's second block `1c7126`, both recorded in §14e as absent, plus **panasonic**,
which the PBX has no brand row for at all (detection and provisionability are different
questions). `discoveryFilter` gained `macIsPhoneMaker`, checked **before** the fingerprint
guess in both `looksLikePhone` and `shouldFingerprint`.

⛔ **`vendorSlugFor`'s prefix-match floor is 4, not 5.** A floor of 5 silently excluded
`snom` and `htek` — two four-character slugs — so those brands resolved to nothing while
every longer name worked. Found by driving the real function, not by reading it.

⛔ **The one prefix two makers share is left unnamed, deliberately.** `0c383e` is claimed
by **Fanvil AND Attimo** and it is the only one of the 1,142 distinct prefixes claimed
twice — which also means **Fanvil's only OUI is the shared one**, so no Fanvil can ever be
named by address. That is the price of not guessing, and it costs nothing mechanical: both
brands have the identical PnP shape, so every gate answers the same either way, and
`looksLikePhone` still returns **true** — an ambiguity between two phone makers is still,
unambiguously, a phone. This follows the catalogue's own recorded contract (`vendorForMac`
returns null rather than choosing).

### 18d. Gate 3 — the wizard told customers something untrue

`MAX_PROVISIONING_WAIT_MS` was one hour. After it, the driver sent
`provisioningHandoffFailed: true` and the customer read *"We could not point this phone at
Loopcom from your computer — Loopcom Support can finish this one."*

⛔⛔ **That was false, and §20 of the setup handoff says why in its own words: the desktop
responder is STANDING. It stays armed after the wizard window closes, hourly, for the
tenant's whole phone list.** So the phone is provisioned the moment somebody power-cycles
it — tonight, tomorrow morning, whenever. Telling a customer we had given up, while the
machine was still listening and would still finish the job, is the single most misleading
thing this wizard has ever said.

The clock is **deleted**. The only give-up left is **`MAX_CANNOT_LISTEN_ATTEMPTS = 3`**
consecutive `cannot_listen` refusals — the one case where waiting is genuinely pointless,
because the socket cannot be opened at all so no request can ever arrive. ⛔ Counted
**consecutively** and reset by any success: a single refusal can be the port momentarily
held by something else, and giving up on one bad reading would be as wrong as the clock
was. ⛔ A refusal still never spends a restart attempt, and once we have given up no
further op is sent at all.

### 18e. Gate 4 — a brand nothing can drive had no terminal state

For the 31 models with no LAN mechanism the ladder kept naming `set_provisioning`, the
driver could not perform it, and the run never finished: a progress bar for something that
was never going to happen. `deskPhoneRoutes.ts` gained a Phase-F block in the **same
route-level shape as `handConfiguredVendor`** (Panasonic, §22 of the setup handoff), so the
pure ladder and its 12.6M-decision invariant suite stay untouched:

- **not registered** → `halt` to support with *"This phone has to be pointed at Loopcom by
  hand — its maker gives us no way to do it from your computer."* No reset is spent, no
  folder URL is leaked.
- **registered** → `do_nothing`, and the green-light condition widened to
  `(provisioningIsOurs || handConfiguredVendor || !drivableLocally)` — demanding that a
  phone we can never re-point also be pointing at our folder would leave a working phone
  amber for ever.

### 18f. The responder itself (desktop — committed, NOT yet in an installer)

- **Two ports.** `PNP_PRIMARY_PORT` 5060 and `PNP_SECONDARY_PORT` 5080. Every brand in the
  catalogue documents 5060; **Grandstream's own sources contradict each other** about which
  its phones use, and a phone asking on a port nobody holds is silent failure. ⛔ The
  primary decides whether we are listening; the secondary failing to bind is logged and
  otherwise ignored.
- **Every network, not the OS default.** `localMulticastInterfaces()` joins the group on
  every real private non-loopback IPv4 address. A PC with a cable and Wi-Fi, or an office
  where the phones sit behind an extender, was previously a coin toss — and the failure is
  silent, because the socket is open and the phone just asks into a void. ⛔ Deliberately
  **more permissive than the scanner**: joining a group on a virtual adapter costs nothing,
  while skipping a real NIC because its name carries "VPN" costs the whole feature. A
  fallback `addMembership(group)` runs if no interface accepted.
- **The reply names the port the phone reached us on**, not a constant.
- **The body type is the phone's own `Accept`.** ⛔⛔ That value arrives from a device on
  the customer's network and is written straight into a SIP header, so it is an injection
  surface in the most literal sense: a CR or LF in it would end our header and let the
  phone dictate the rest of the message. `usableContentType` accepts only a plain
  `type/subtype` of RFC 7230 token characters, bounded, and anything else falls back to
  `application/url` — refused, never sanitised. Re-validated **inside** `buildPnpNotify`
  as well as at the parser, because that is the function that writes the header and it
  must not depend on a caller having been careful.

### 18g. Found in passing — a guard that guarded nothing

`deskPhoneWizard.test.ts`'s "no protocol jargon in customer copy" check read
`/\x08(HTTP|SIP|DHCP|...)\x08/i` — **two literal BACKSPACE bytes** where `\b` word
boundaries were meant. A bash heredoc turned each `\b` into the control character it
names. A backspace never appears in customer copy, so **that guard has matched nothing
since the day it was written.** Repaired at the byte level and re-proven: the fixed form
catches `"...over HTTP, try again"`, `"Checking the provisioning folder"` and
`"DHCP option 66"`, passes honest copy, and the broken form matches none of them. The
wizard's copy turned out to be clean — the cost was the guard, not the product.

⛔ This is the documented heredoc trap, now four sightings deep in this repo. **Write any
file containing escapes with the editor.**

### 18h. Proof

| suite | result |
|---|---|
| `packages/shared` | **597 / 597** |
| `apps/desktop` | **285 / 285** |
| `apps/api` desk-phones | **101 / 101** |
| `apps/portal` full | **581 / 585** — the 4 documented pre-existing, none in a touched file |

Typechecks: shared **0**, desktop **0**, portal **0**, api **84 = the exact baseline** with
**none in any edited file**.

⛔ **Every new test was replayed against HEAD by swapping the eight changed source files
back** (backed up first, restored byte-identically after — verified with `cmp`):

| | fails at HEAD |
|---|---|
| shared invariants | **2 of 2** rewritten tests |
| desktop pnp + resident | **4** (the Accept echo, three two-port/interface tests) |
| portal driver + wizard | **3** (Grandstream listened for, the hour, the give-up threshold) |
| api routes | **5** (catalogue naming ×2, the shared block, both Phase-F tests) |

⛔ **Named honestly: the tests that PASS at HEAD are regression guards, not bug-proofs** —
the hostile-`Accept` test (HEAD hard-coded the literal, so nothing could be injected), the
`cannot_listen` recovery test (HEAD never set the flag at all), and the api's Grandstream
ladder test (the api never had the Yealink gate — that gate was in the driver). They are
kept because they pin the new contract; they are not counted as evidence of the fix.

### 18i. NOT PROVEN

⛔ **No phone of any brand has been set up through this.** It is proven as tests, as
typechecks, and as code verified inside the running containers — never as a handset that
registered. **Izzy's rig is the acceptance test**: Yealink 192.168.6.170, Grandstream
GXP2170 .171, Grandstream .172, Grandstream HT812 192.168.4.22, all four on ext 101
"Home" (Landau Home, PBX T21).

⛔ **The desktop half — two ports, multi-interface join, the Accept echo — is committed and
is on NO machine.** It rides the next installer, which is Izzy's call to build and publish
(publishing auto-updates the whole fleet). Until then his office runs rc.10's responder:
one socket, 5060, one interface. **The portal and api halves do NOT wait for it** — the
gates, the naming and the honest states are live now.

⏳ **Deliberately not built:** the Grandstream HTTP write path (`api.values.post` needs the
sticker admin password, so Grandstream rides the PnP power-cycle path instead and its
adapter stays `documented`), and Phase B's in-app Windows firewall prompt.
