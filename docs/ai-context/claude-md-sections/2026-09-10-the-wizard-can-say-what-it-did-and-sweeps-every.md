# ⛔⛔ AGENT HANDOFF — the wizard can SAY WHAT IT DID and sweeps EVERY network now, the finish screen stopped lying, and Izzy's flow is MOCKED UP AWAITING APPROVAL (2026-09-10 evening) — READ FIRST before touching `apps/desktop/src/phoneSetup/`, before flipping `vendorSupportsLocalActions` for any brand, or for "the wizard is stuck on Preparing"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §15**
(`731e04c0` + `3e21ceec` on `feat/ivr-migration-takeover`, pushed. **Desktop + portal
source only — NOTHING IS DEPLOYED, no desktop build exists, and Izzy's stuck Yealink is
unchanged on his screen.**)
Mockup awaiting his approval: <https://claude.ai/code/artifact/f5047981-e442-482a-9cdd-315670161f73>

- ⛔⛔ **THE CONSENT MODEL IS THE TICK — Izzy corrected me on this and it is the design.**
  *"As long as the customer unchecks that box, that phone does not get factory reset. Only
  the checkboxes of the phones the customer checks to be connected to Loopcom get factory
  reset."* So there is **NO separate approval card**: the found screen states plainly that
  ticking wipes the phone, and `resetAuth` collapses into the selection.
- ✅ **THE SUBSYSTEM WAS SILENT FOR ITS ENTIRE LIFE, AND NOW IS NOT.** `main.ts:844` called
  `registerPhoneSetup({ ipcMain, safeStorage })` with **no `log`**, so
  `createPnpResident({ log: deps.log })` got `undefined` and `connect.log` held **ZERO**
  phoneSetup lines, ever — which is why a stuck run needed a production DB read to diagnose.
  Now main.ts passes `diag("phoneSetup", …)`, mainWiring threads it to BOTH the resident and
  the capability, and the capability logs from **ONE wrapper** (`run` → `runInner`), so a new
  op or a new refusal cannot be silent. ⛔ A provisioning URL is reduced to its **HOST** —
  its path carries the 16-hex tenant folder hash, the credential a phone uses to fetch its
  own SIP password, and a log is something a customer pastes into a ticket.
- ✅ **`scanLan` SWEPT ONE NETWORK AND WROTE A NOTE ABOUT ITS OWN BUG** (*"This computer is
  on N networks; only X was scanned."*). It now sweeps **every** local network, smallest
  first, merged by MAC, under a **3,000-address budget across all of them**, naming any
  network too big to fit. `subnet` keeps its meaning (the first swept) because the portal
  stores it; new `subnets[]` carries the truth. ⛔ Virtual adapters are filtered **by NAME**
  as well as range — Hyper-V/WSL/Docker all sit in 172.16–31, which IS RFC1918.
  ⛔⛔ **BUT THIS IS NOT WHAT BROKE IZZY'S YEALINK** — measured on his machine, his single
  Wi-Fi **192.168.4.0/22** already spanned all four of his phones. Do not claim it as the fix.
- ✅ **THE FINISH SCREEN CLAIMED SUCCESS IT DID NOT HAVE.** His screen: a **green tick** over
  **"0 of your 1 phones are ready"** with *"Your office is working."* `summarizeRun` was
  honest the whole time (ready 0, needsAttention 1); the JSX drew the tick
  **unconditionally** and branched on `needsAttention` alone, so "nothing connected" and
  "one of six still to do" rendered identically. Three outcomes, three marks now; "working"
  is printed only when a phone actually is.
- ⛔⛔ **DO NOT FLIP `vendorSupportsLocalActions` FOR GRANDSTREAM — it would be WORSE than
  the stall.** `capability.ts` imports only `yealink.ts`, so the driver would point
  Yealink-shaped HTTP at a Grandstream. The adapter must be captured off the real devices
  first, which needs Izzy's permission (below).
- ⛔ **The Yealink is still halted and the Grandstreams still stall.** The
  `provisioningHandoffFailed` override still converts `set_provisioning` → halt-to-Support;
  ⛔ removing it alone is NOT the fix (it exists so a give-up does not restart somebody's
  phone forever) — plan §5's shape needs the server and driver changed together. No terminal
  decision exists yet for a vendor with a PBX template and no local adapter (§7).
- ⏳ **FOUR DECISIONS ARE IZZY'S AND TWO GATE REAL WORK:** approve the mockup; **may the
  agent sign in to the GXP2170 (192.168.6.171) and HT812 (192.168.4.22) on his LAN with
  default credentials to capture the config API** (Phase E cannot be guessed — a wrong
  P-code configures nothing silently); do the `connection`/`network` middle screens come
  out; and are all four devices really meant to share ext 101.
- ✅ Proven: desktop **283/283** + tsc 0; portal tsc 0, **566/562** (the 4 failures are all
  pre-existing and none in a touched file — two documented here, plus `nativeSelectSweep`
  (OrdersDesk.tsx:563) and `coworkerHands` from other sessions). All six new source guards
  fail replayed against HEAD via `DESKTOP_GUARD_ROOT` / `PORTAL_GUARD_ROOT`.
