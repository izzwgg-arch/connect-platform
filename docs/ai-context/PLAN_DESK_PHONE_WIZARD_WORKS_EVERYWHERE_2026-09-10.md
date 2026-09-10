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
