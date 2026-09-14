# ⛔⛔ AGENT HANDOFF — the desk-phone wizard WORKS FOR EVERY BRAND now, not just Yealink; the hour-long "we gave up" was a FALSE STATEMENT to the customer (2026-09-11) — READ FIRST before touching `vendorSupportsLocalActions`, `setupDriver.ts`, `guessVendorFromMac`, the PnP responder's ports, or before adding a clock to anything the desktop is still listening for

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §18**
(`dac3aab2` on `feat/ivr-migration-takeover`, pushed. **api + portal DEPLOYED and
container-verified** — `app-api-1` `.build-commit` = `dac3aab2`, 0 restarts, 0 error-level
lines, health 200 on both hostnames, and the new wiring grepped inside the running
container. ✅ **THE DESKTOP HALF SHIPS IN rc.11 — BUILT AND VERIFIED 2026-09-11:**
`Connect-Setup-0.1.17-rc.11.exe`, 100,514,722 bytes, sha256 `faeb0f1c9824e97fd705fc4f5688ea60a7b7f4ca0b5dea5d413a93bdae6cbbaf`, in `apps/desktop/release/` (version bump `fdc0173c`). ✅ **INSTALLED ON IZZY'S WORKSTATION (`DESKTOP-8HUS877`) 2026-09-11 AND RUNNING** — the installed asar is **sha256-identical** to the verified build, banner `=== log start v0.1.17-rc.11 win32 ===`, 7 processes, **0 error lines**, and `electron-updater` demonstrably LOADS (it refuses the rc.10 feed as a downgrade — that is the very module the broken 14:24 rc.10 build crashed on). ⛔ **NOT published — the fleet feed stays at rc.10, so NO OTHER MACHINE has it;** publishing is Izzy's call. ⏳ **The every-brand responder has NOT been exercised here:** it arms from the portal's `PnpResidentHost` only for a tenant that HAS desk phones, and this login's tenant has no PBX link, so rc.11 logged **0 `phoneSetup` lines**. ⛔ `[SipPhone][conn] init-failed` on boot is PRE-EXISTING, not this build — proven from this box's own log, where rc.10 logged it **14 times** and rc.11 once. No migration, no PBX write, no env change, no tenant row.)
Izzy: *"Every single phone should be able to be connected through the wizard, all 427.
I'm going to run a live test again on my network."*
Memory: [[wizard-listens-for-every-brand]], [[one-gate-must-not-answer-two-questions]].

- ⛔⛔ **IT WAS NEVER A MISSING ADAPTER — IT WAS FOUR GATES SHAPED AROUND ONE VENDOR.**
  §14 built adapters for all 427 models and recorded that nothing consumed them, so the
  obvious next step looked like "write a Grandstream executor". **A census of the
  catalogue says otherwise: 369 of the 427 models are on brands that send an IDENTICAL
  PnP `SUBSCRIBE`** — `Event: ua-profile` to `224.0.1.75`, port **5060**, body
  `application/url`, ten brands, nothing per-vendor to get right. 396 of 427 are drivable
  from the LAN by some mechanism; **31 across four brands publish none at all**
  (Alcatel-Lucent 15, Dinstar 14, Nurivoice 1, Hanyang 1 — and ⛔ Dinstar has **no OUI
  rows in the catalogue at all**). The wire protocol already covered most of the fleet.
- ⛔⛔ **GATE 1 — ONE BOOLEAN ANSWERED TWO DIFFERENT QUESTIONS.**
  `vendorSupportsLocalActions` was true for **Yealink alone**, and its own comment
  justified that in terms of **Action URI**, i.e. about **speaking** to a phone. The
  driver then used it to decide **listening**, which is a different question with a
  different answer — so Grandstream, Polycom, Snom and the rest were refused a step whose
  entire local half is *opening a socket and waiting*, and sat on "Preparing" until
  somebody gave up. **Split in `vendorAdapters.ts`, beside the data that answers them:**
  **`vendorSupportsHttpActions`** (may we send a request AT it — `VENDORS_WITH_A_SHIPPED_HTTP_EXECUTOR`,
  today `["yealink"]`) and **`vendorSupportsPnpHandoff`** (may we ANSWER when it asks us).
  ⛔ **The failure directions are OPPOSITE and that is the design:** an unidentified device
  answers **false** to "may we speak to it" (talking to a device we cannot name is a guess,
  and Yealink shapes aimed at a Grandstream configure nothing while looking like they
  worked) and **true** to "may we listen for it" — arming the responder costs a hardware
  address on a listener that answers nothing else, a non-PnP device simply never asks, and
  **a locked phone from a previous provider reports no vendor at all, which is precisely
  the phone this wizard exists for.** `vendorCanBeDrivenLocally` is the OR, used only to
  choose between a progress bar and an honest hand-off; `deviceKinds.ts` delegates to it.
  ⛔ In the driver, `rediscover` moved **above** the gate and is ungated (a network sweep
  is not a request at a phone), and the restart is `canHttp && attempts < 2`.
- ⛔⛔ **GATE 2 — THE HARDWARE-ADDRESS LIST WAS 12 PREFIXES FOR 4 MAKERS** against the
  PBX's own **1,143 across 20 brands**. So a Polycom, a Snom, an Htek, an Atcom or a
  Sangoma came back `unknown`, and `looksLikePhone` then filed a real desk phone under
  **"other devices we left alone"** — it never reached the found screen and nothing
  downstream ever got the chance. `guessVendorFromMac` reads the catalogue
  (`vendorsForMac`) first; `VENDOR_PREFIXES` is now a **three-entry supplement** for the
  two IEEE blocks §14e records as MISSING from the PBX table (Flyingvoice `789912`, Snom
  `1c7126`) plus **panasonic**, which the PBX has no brand row for at all.
  `discoveryFilter` gained `macIsPhoneMaker`, checked **before** the fingerprint guess.
  ⛔ **`vendorSlugFor`'s prefix-match floor is 4, NOT 5** — a floor of 5 silently excluded
  `snom` and `htek`, two four-character slugs, so those brands resolved to nothing while
  every longer name worked. Found by driving the real function, not by reading it.
  ⛔⛔ **`0c383e` (Fanvil + Attimo) stays UNNAMED, and it is Fanvil's ONLY prefix** — so no
  Fanvil is ever named by address. Deliberate, and it costs nothing mechanical: both
  brands have the identical PnP shape so every gate answers the same either way, and
  `looksLikePhone` still returns **true**, because an ambiguity between two phone makers
  is still, unambiguously, a phone. It follows the catalogue's own recorded contract.
- ⛔⛔ **GATE 3 — THE WIZARD TOLD CUSTOMERS SOMETHING UNTRUE, AND THIS IS THE WORST OF THE
  FOUR.** After `MAX_PROVISIONING_WAIT_MS` (one hour) the driver sent
  `provisioningHandoffFailed: true` and the person read *"We could not point this phone at
  Loopcom from your computer."* **The desktop responder is STANDING — §20 of the setup
  handoff says so in its own words: it stays armed after the wizard window closes, hourly,
  for the tenant's whole phone list.** So the phone is provisioned the moment somebody
  power-cycles it, tonight or tomorrow. **The clock is DELETED.** The only give-up left is
  **`MAX_CANNOT_LISTEN_ATTEMPTS = 3`** consecutive `cannot_listen` refusals — the one case
  where waiting really is pointless, because the socket cannot be opened so no request can
  ever arrive. ⛔ Counted **consecutively** and reset by any success (a single refusal can
  be the port momentarily held by something else); a refusal still never spends a restart;
  and once we have given up no further op is sent at all. ⛔ **Never re-add a clock here.**
- ⛔ **GATE 4 — a brand nothing can drive now reaches a FINISHED state.** For those 31
  models the ladder kept naming `set_provisioning`, the driver could not perform it, and
  the run never finished — a progress bar for something that was never going to happen.
  `deskPhoneRoutes.ts` gained a Phase-F block in the **same route-level shape as
  `handConfiguredVendor`** (Panasonic), so the pure ladder and its 12.6M-decision invariant
  suite stay untouched: **not registered → halt to support** in plain words, no reset
  spent, no folder URL leaked; **registered → do_nothing**, with the green light widened to
  `(provisioningIsOurs || handConfiguredVendor || !drivableLocally)` — demanding that a
  phone we can never re-point also point at our folder leaves a working phone amber for ever.
- ⛔ **THE RESPONDER (desktop, committed, on NO machine):** it holds **udp/5060 AND 5080**
  — every brand documents 5060, but **Grandstream's own sources contradict each other**
  and a phone asking on a port nobody holds is silent failure (⛔ the primary decides
  whether we are listening; the secondary failing to bind is logged and ignored). It joins
  the multicast group on **every** local network via `localMulticastInterfaces()`, because
  a PC with a cable and Wi-Fi was a coin toss and the failure is silent — the socket is
  open and the phone just asks into a void; ⛔ deliberately **more permissive than the
  scanner** (joining on a virtual adapter costs nothing; skipping a real NIC whose name
  carries "VPN" costs the feature). The reply names the port the phone reached us on.
  ⛔⛔ **And the body type is the phone's OWN `Accept` — which means an untrusted value
  from a device is written into a SIP header.** `usableContentType` accepts only a bounded
  plain `type/subtype` of RFC 7230 token characters and otherwise falls back to
  `application/url`: **refused, never sanitised.** Re-validated INSIDE `buildPnpNotify` as
  well as at the parser, because that is the function that writes the header.
- ⛔ **FOUND IN PASSING — A GUARD THAT GUARDED NOTHING.** `deskPhoneWizard.test.ts`'s "no
  protocol jargon in customer copy" check read `/<BS>(HTTP|SIP|DHCP|…)<BS>/i` with **two
  literal BACKSPACE bytes** where `\b` word boundaries were meant — a bash heredoc turned
  each escape into the character it names. A backspace never appears in customer copy, so
  **it has matched nothing since the day it was written.** Repaired and re-proven (the
  fixed form catches "over HTTP", "provisioning folder" and "DHCP option 66"; the broken
  form catches none of them). The copy itself was clean. **Fourth sighting of the heredoc
  trap in this repo — write any file containing escapes with the editor.**
- ✅ **Proven:** shared **597/597**, desktop **285/285**, api desk-phones **101/101**,
  portal **581/585** (the 4 documented pre-existing, none in a touched file). Typechecks
  shared/desktop/portal **0**, api **84 = the exact baseline** with none in an edited file.
  ⛔ **Every new test replayed against HEAD by swapping the eight changed source files back**
  (backed up first, `cmp`-verified identical after): **2 of 2** shared, **4** desktop,
  **3** portal driver/wizard, **5** api fail there. ⛔ **The ones that PASS at HEAD are
  named as regression guards, not counted as proof** — the hostile-`Accept` test (HEAD
  hard-coded the literal), the `cannot_listen` recovery test (HEAD never set the flag) and
  the api's Grandstream ladder test (the api never had the Yealink gate; that gate was in
  the driver).
- ⏳ **NOT PROVEN: no phone of ANY brand has been set up through this.** It is proven as
  tests, typechecks and code read inside the running containers — never as a handset that
  registered. **Izzy's rig is the acceptance test:** Yealink **192.168.6.170**, Grandstream
  GXP2170 **.171**, Grandstream **.172**, Grandstream HT812 **192.168.4.22**, all four on
  ext **101 "Home"** (Landau Home, PBX **T21**). ⛔ **His office runs rc.10's responder** —
  one socket, 5060, one interface — until an installer ships, so the two-port and
  multi-interface halves are NOT live for him; the gates, the naming and the honest states
  ARE. ⛔ An already-open portal tab or desktop window keeps the OLD bundle until reloaded.
- ⏳ **Deliberately not built:** the Grandstream HTTP write path (`api.values.post` needs
  the sticker admin password, so Grandstream rides the PnP power-cycle path and its adapter
  stays `documented`), and Phase B's in-app Windows firewall prompt.
