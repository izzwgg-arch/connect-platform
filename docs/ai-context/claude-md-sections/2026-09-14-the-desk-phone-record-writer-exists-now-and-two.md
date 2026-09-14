# ⛔⛔ AGENT HANDOFF — the desk-phone RECORD WRITER exists now, and two defects that would have broken it on day one were caught BEFORE it shipped (2026-09-14) — READ FIRST before touching `provisioningRecordWriter.ts`, before letting ANY route write another tenant's PBX data, before writing a PBX test fixture, or before assigning one of Izzy's rig phones in the wizard

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full record: **`docs/ai-context/PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §20**
(`02bf88c4` rules → `961324ac` routes → `257b0b07` make/model pickers → `b9956746` fixes,
on `feat/ivr-migration-takeover`. ✅ **api + portal DEPLOYED and container-verified at
`b9956746` (2026-09-14)** — both `.build-commit` = `b9956746`, 0 restarts, 0 error-level
lines; `held_by_another_account` / `decideRehome` / `requesterIpOf` / the `/identify` route
grepped inside `app-api-1`; `dps-idrow` + `/identify` in the shipped portal chunks; health
and `/settings/desk-phones` 200 on both hostnames. No migration, no PBX write, no env change.
⛔ An open desktop window or tab keeps the OLD bundle until fully reopened.
The desktop `factory_reset` half is on NO machine until an installer ships.)
Memory: [[desk-phone-record-move-needs-proof-of-presence]].
Izzy: *"the record writer first (that's the wall), then un-sticking phones, then
reset/reboot over the network, then the dropdowns, then the switch and extender."*

- ✅ **The §19 wall is down in code.** Assigning a phone (assign / retry / identify) now
  writes its `provisioning.devices` row through the proven `save_phone`, so the PnP
  resident can finally answer a phone the PBX never knew. `planProvisioningRecord`
  (shared, pure) decides insert / move / rebind / adopt; a phone with no settings profile
  is **refused**, never written as a row that renders nothing. `POST …/retry` un-sticks
  `NEEDS_ATTENTION` and **never forgives a reset**. Make + model are two ConnectSelects fed
  from the generated catalogue, with a drawing of where the label sits.
- ⛔⛔ **DEFECT 1: `ombu_devices.user` IS THE BARE EXTENSION (`101`, `101_1`), NEVER
  `T21_101`.** The PBX composes the endpoint name itself; live census **158 pjsip devices,
  0 prefixed**. The writer matched `T21_101` — copied from a test fixture that invented the
  prefixed shape — so **every real write would have refused "no desk device" while every
  test passed.** ⛔ **Read one real row before writing a PBX fixture.**
- ⛔⛔ **DEFECT 2: THE "MOVE" BRANCH LET ANY CUSTOMER TAKE ANOTHER COMPANY'S PHONE.** It
  re-pointed a record held by another PBX tenant on the strength of *"our scan found it on
  their LAN"* — but `/discovered` is posted by the customer's own computer and **proves
  nothing**. `decideRehome` (shared, pure) now allows a move ONLY when the other record is
  bound to no living extension, OR nothing registered there in **14 days**, OR the only
  live registration is **this handset** (`x-ast-orig-host` == our scan IP **and** contact
  public IP == the requester's **last** `X-Forwarded-For` entry). Unreadable evidence
  refuses `held_by_another_account`; the customer reads "Loopcom Support needs to finish
  setting up this phone" and is **never** told another company holds it.
  ⛔ **A cross-tenant write gated on client-supplied data is a hijack path — any future
  one needs server-side evidence (`PbxEndpointRegistration`), never a client report.**
- ⛔⛔ **§19 BELOW IS WRONG IN TWO PLACES — read these corrections over it.** "NOTHING IS
  BUILT" is superseded by this section; and **"nothing has leaked" is only half true:
  two of Izzy's rig devices are LIVE right now as other customers' extensions** — his
  GXP2170 `.171` answers **Create A Box ext 106** and his HT812 `192.168.4.22` answers
  **A plus center ext 108 "Home"**, both registered from 50.48.58.53. ⛔ **Assigning those
  two in the wizard WILL move their records** (the rule allows it — it is his handset on
  his network), and 106 / 108 lose that device. The `.172` GXP2170 is refused: T7_102 is
  Create A Box's real office phone via their tunnel. Whether 106/108 are deliberate is
  **Izzy's call; nothing was changed on the PBX.**
- ✅ **Proven:** shared **672/672**, api desk-phone **150/150**, portal wizard **56/56**;
  typechecks shared/portal 0, api **84 = the exact baseline**. **Replayed against HEAD:
  16 of 21 writer tests and 3 of 28 wiring tests fail there** (three "move refused" tests
  first passed at HEAD for the wrong reason and were tightened to assert the reason).
- ⏳ **NOT PROVEN: no record has been written on production by the writer.** Acceptance on
  the rig: assign the Yealink `80:5e:c0:b3:b2:d0` to ext 101 → a `provisioning.devices`
  row appears bound to device **130** → power-cycle → `T21_101` registers. The negative
  that matters most: the `.172` GXP2170 must come back **refused**.
- ✅⛔⛔ **RESET OVER THE NETWORK IS WIRED NOW, AND A RESET IS COUNTED ONLY WHEN IT IS SENT
  (plan §20f, 2026-09-14 later).** Before: the portal driver never called `factory_reset`
  and `advance` SPENT the phone's one reset the moment it decided one (a phone lost its
  reset untouched). Now the driver runs `fingerprint` → `factory_reset {ip, model,
  link:"unknown", authorizationId}` for `reset_over_lan`, and the reset is counted by the
  new **`POST …/phones/:phoneId/reset-sent`** (atomic claim, one audit row, clears the old
  provisioning URL). `advance` only decides and returns `resetAuthorizationId`
  (`<runId>.<approvedAtMs>`). ⛔ **Never move the counter back into `advance`** — a source
  guard fails. ⛔ Approval is **per phone** (`resetApprovalFor`); re-authorising unions the
  list. ⛔ A desktop fence refusal is never reported — the next advance carries
  `resetRefusedLocally` and becomes the non-destructive `set_provisioning`; a timeout after
  the fence IS counted (a wiping phone stops answering). Reboot wait bounded at 120 s.
  ⛔ `reset_over_sip` (rung 7, registered phones) still has **no executor** — the driver
  stalls on it and spends nothing. ⛔ **Proven with fakes only — Izzy does every reset on
  his network himself.** ✅ **SHIPPED 2026-09-14 05:35Z: api `4e9f5c33`, portal `0f500b11`
  (container-verified, `reset-sent` in the shipped desk-phones chunk), and desktop rc.12
  INSTALLED on Izzy's PC — asar sha256-identical to a clean export of `0f500b11`, updater deps
  complete, icon OK, 0 error lines. NOT published (feed unchanged).** ⏳ No reset has reached a
  real phone yet — that is Izzy's test on his rig. Detail in §20f.
- ⛔⛔ **FACTORY RESET FIRST, ALWAYS — BUILT IN ALL FOUR LAYERS (plan §20h, 2026-09-14).**
  Izzy: *"The first thing that happens before connecting any phone to my system is a factory
  reset. Once it's on, factory reset it, send the profile, and then the wizard should restart
  that phone."* The ladder resets every ticked phone with `resetCount === 0` BEFORE any
  settings; **ticking the phone IS the approval** (`/selection` writes `resetAuthorizedAt` +
  the ticked ids); a retry is a fresh go and resets again; the reset fence refuses only a
  model nobody can name (adapter/cordless/door/Wi-Fi refusals removed from BOTH copies); a
  401/403 on the reset is `refused: "locked"` and is never counted. ⛔ **Never bring back
  "lightest step first, reset last" — that was never his rule.** ⛔ Honest limits: a phone
  locked by another provider needs its password or one hands-on reset; `reset_over_sip` has
  no executor; only Yealink has a network reset. Also: the live screen has **Cancel setup** +
  a 10-minute no-progress timeout. ✅ **SHIPPED 2026-09-14 ~06:55Z: api + portal `882c9bee`
  (container-verified), desktop rc.13 built from a clean export of `b1d2a554` and INSTALLED on
  Izzy's PC** (installed asar sha256-identical to the checked build, all updater deps packed,
  0 error lines, PnP resident listening). ⛔ NOT published — feed stays rc.10. ⏳ No reset has
  reached a real phone; the Yealink `.170` sits at `resetCount 0`, so Izzy's next run resets it
  first. Detail in §20h.
- ⛔⛔ **"I RAN ONE SETUP AND NOTHING HAPPENED" (2026-09-14, plan §20g, `350d25ab`):** the only
  phone he ticked was already NEEDS_ATTENTION from 09-10 with no model, the driver skips
  finished phones, and **no screen ever called retry** — so nothing left the machine. Now:
  ticking a stuck phone retries it; a model-less phone blocks Continue until named; **every
  step is announced BEFORE it runs** (`onProgress`, sticky last message per phone); and
  ⛔ **the finished screen opens ONLY when every chosen phone is REGISTERED** (Izzy: "never
  come up unless the phone is up and registered, ready to make calls") — a stuck phone stays
  on the live screen with its reason and **Try again**. ⛔ Never go back to `if (out.finished)`
  alone — `finished` includes phones needing attention. Deploy state in §20g.
- ⛔ **The picker + sticker screens were built WITHOUT a mockup**, against Izzy's standing
  mockup-first rule — show him before calling them final. ⏳ Still open: PoE switch /
  Wi-Fi extender (needs brand + model from Izzy), §19f's screen defects (unconditional
  green tick, subtitle failure branch, per-phone note, IP hidden), `retryableCount` /
  `inheritedResetCount` unwired, stage-2 reset research not re-run.
