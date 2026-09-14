# ⛔⛔ AGENT HANDOFF — Izzy's HANDS-OFF mandate: factory-reset FIRST (he was told the cost and reaffirmed it), Wi-Fi phones too, and THREE OF HIS FOUR RIG PHONES CARRY ANOTHER CUSTOMER'S IDENTITY ON THE PBX (2026-09-11) — READ FIRST before touching the desk-phone wizard again, before proposing a reset order, before answering "why didn't the Yealink connect", or before trusting a MAC read off a screenshot

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full record: **`docs/ai-context/PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §19**
(**Decisions and measurements only — NO code changed, nothing deployed, no PBX row
written.** Every PBX fact below is a read-only `SELECT` / `asterisk -rx "... show ..."`,
**re-verified 2026-09-11** by a second session, not carried over on trust.)
⛔ **This is a RECOVERY.** The session that took these decisions filled up, compacted,
and then could not answer at all ("Prompt is too long"). Its final instruction was
*"update MD file."* and **that write never landed** — every decision below would
otherwise be gone. This is the failure the two standing rules exist to prevent.

- ⛔⛔ **THE DECISION: factory-reset EVERY phone first, and he was warned in writing
  before he reaffirmed it.** Izzy: *"once the customer hits Set Up the Phone, the first
  thing the wizard is supposed to be doing is taking both phones and preparing them
  (meaning factory resetting them, all of them) … Once it comes back online, the wizard
  should take them, upload the provisioning profile, and then restart. That's it."* Then,
  after the pushback: *"before the customer says to connect the phones to our system,
  even if the phone is stuck in somebody's DHCP, the system should find every single
  possible way to factory reset the phone and be able to switch it to us."*
  **What he was told, and it is all still true:** `factory_reset` is refused by the
  desktop app today **and two tests exist whose only job is to assert it is never
  added** — so this reopens a deliberate decision, it does not tune one; the server's
  ladder puts reset at rungs 6 and 7 behind approval **because the dependency runs
  backwards** (resetting over the network needs the admin password, and if you have that
  you do not need the reset — reset is the tool you can only use on phones that do not
  need it); ⛔⛔ **a factory reset erases network settings, so a Wi-Fi phone forgets the
  SSID and passphrase and is permanently unreachable** — which kills his own
  *"even if the desk phone works with Wi-Fi as well"* requirement; and reset erases an
  HT ATA's analog line config (our own code forbids it) and can unpair a DECT base.
  ⛔⛔⛔ **CORRECTED 2026-09-14 — THERE WAS NEVER AN "AGREED SHAPE". Izzy, restating it:
  *"The system should always factory reset first… hard rule from the beginning… Once it's
  on, factory reset it, send the profile, and then the wizard should restart that phone so
  it kicks in. The whole thing has got to be automated."*** The line that stood here
  ("PREPARE picks the lightest thing that works… reset is used when it is the only way")
  was written by the 09-11 session and **he never agreed to it**; the 09-14 session then
  quoted it back to him as fact. **THE RULE: every ticked phone → (1) factory reset →
  (2) back online → (3) profile → (4) restart → (5) REGISTERED, fully automated; ticking
  is the consent.** Do not re-argue the costs above — he has heard them. Memory:
  [[reset-first-is-izzys-decision-cost-stated]].
- ⛔⛔ **THREE OF THE FOUR PHONES ON HIS DESK ARE RECORDED UNDER OTHER CUSTOMERS, and
  the rig cannot provision cleanly until that is fixed.** Verified live in
  `provisioning.devices`: **HT812 `C0:74:AD:E5:79:37` → PBX tenant 2 `a_plus_center`**
  ("Home"); **GXP2170 `c0:74:ad:8c:65:4e` → tenant 7 `create_a_box`** ("106");
  **GXP2170 `c0:74:ad:8c:60:5f` → tenant 7 `create_a_box`** ("102"); **HT801
  `EC:74:D7:20:1F:EA` → tenant 21 `test` (Landau Home), "101" — correct.**
  ⛔⛔ **CORRECTED 2026-09-14: "nothing has leaked" was only half true — his GXP2170 `.171`
  is LIVE as Create A Box ext 106 and his HT812 as A plus center ext 108 (see the top
  section).** (Original wording:) ⛔ **Nothing has leaked** — the names on his screen come from his own assignment in the
  wizard, not from those rows — but a phone's provisioning file is keyed on its MAC, so
  today two of his phones would be handed **Create A Box's** config. Cleaning the three
  rows is a **PBX write and needs his mandate.**
- ⛔ **CORRECTION — the HT801's MAC is `EC:74:D7:…`, NOT `EC:74:07:…`.** The 2026-09-10
  note read it off a zoomed screenshot and misread `D7` as `07`. `EC:74:D7` is a real
  Grandstream OUI; `EC:74:07` is not. The conclusion was right, the digits were wrong.
  **Take a MAC from the database, never from a picture of a screen.**
- ⛔⛔ **WHY HIS RESTARTED YEALINK STILL DID NOT CONNECT, and it is the chicken and egg
  that blocks the whole feature: `80:5e:c0:b3:b2:d0` has NO provisioning row on the PBX
  at all, on any tenant** (a loose `LIKE '%b2d0%'` over `provisioning.devices` returns
  nothing). The PnP resident answers **only MACs already recorded for that tenant** — so
  the phone almost certainly announced itself on boot and **we deliberately said nothing
  back.** ⛔ **This means the every-brand responder shipped in `dac3aab2` can only
  RE-POINT a phone the PBX already knows; it cannot finish a NEW one.** That is the real
  content of Phase D and it is not built.
- ⛔ **"Not connected" is TRUE and answers the wrong question.** The pill reads exactly
  one thing — is this extension registered to Asterisk (`defaultIsRegistered`,
  `apps/api/src/deskPhoneSetup/deskPhoneRoutes.ts:140`). Live: **`T21_101` is
  `Unavailable`, 0 of inf contacts** (no desk phone has EVER registered on it), while
  `T21_101_1` holds two `Avail` contacts — Izzy's own two windows. The defect is that
  the row shows a MAC **our own LAN scan pulled off the network seconds earlier** and
  then says "Not connected", **and the IP is deliberately hidden as a technical field.**
  ⛔ **All four rig phones point at ext 101 — ONE endpoint, one answer — so the moment
  any one registers, all four rows go green including the three that did not.**
- ⛔ **Three more screen defects, all real, none fixed:** `DeskPhoneWizard.tsx:882`
  draws the green success circle **unconditionally**, so 0-of-1 gets the same tick as
  all-ready, and the subtitle's only branch is `needsAttention === 0` so a total failure
  falls through to *"Your office is working."*; the per-phone plain-English note sits in
  the database and **is never shown**, and its advice ("Loopcom Support can finish this")
  is itself wrong — the real next step is to power-cycle the phone with the wizard open;
  and ⛔ **"Yes, I can see a name on it" is a dead end** — the free-text box is sent to
  the server by NOTHING and produces one sentence on the results screen. Izzy's fix
  (*"a dropdown with manufacturers … the second dropdown will be the model and the
  depiction for where to find the brand and models on the back of the phone"*) turns it
  into a real fact, **and the 20 brands / 427 models behind it already exist** (§14).
- ⛔ **No new wizard.** Izzy: *"you don't need to design a new wizard. You can use the
  existing one. It should just function the way I wanted it to function."* Screen
  changes still go **mockup-first** by his own standing rule.
- ⛔ **The PoE switch and the Wi-Fi extender are not a label, they are the missing
  mechanism.** `discoveryFilter.ts` counts every non-phone for the honesty line
  (*"88 other devices"*) and **throws the MAC and IP away**; nothing in the codebase
  models a switch, an extender or LLDP. A reset Yealink only announces itself **when it
  boots**, so knowing the switch is what lets the wizard cycle the port instead of asking
  a human to unplug — which is the whole hands-off ask. The extender matters for the
  opposite reason: discovery rides multicast and many extenders do not forward it —
  **Izzy's HT812 is on 192.168.4.22 while his PC is on 192.168.6.x, so that boundary is
  already live on his own rig.** ⛔ Two limits to state rather than paper over: an
  **unmanaged** switch has no control plane and nothing can cycle it, and cycling a port
  drops everything on it, so it needs the same approval card a factory reset gets.
  ⏳ **Blocked on Izzy: the switch and extender brand + model, and whether the switch has
  a web page.** No vendor codes will be guessed — the real device gets probed, as
  Grandstream was in §16.
- ⛔ **THE RESEARCH THAT WOULD ANSWER "every possible way" WAS LOST AND IS STILL
  MISSING.** Two workflows were stopped: `hands-off-desk-phone-setup`
  (`wf_8d556a05-621`) returned **4 of 10** agents — **all stage-1 reads of our OWN code**
  (PBX NOTIFY surface, the ladder map, what the desktop can drive, the catalogue's
  provenance) — and `hands-off-wifi-desk-phones` (`wf_06999905-7bf`) returned **0 of 6**.
  **The six stage-2 agents — the actual cross-vendor reset/reboot sweep across all 20
  brands and what a PoE switch can be driven to do — returned nothing, so that question
  is unanswered.** ⛔ Both runs are resumable (`Workflow({scriptPath, resumeFromRunId})`,
  completed calls return cached); **read `journal.jsonl` first** — it records each
  agent's real return value, so you can see what is genuinely cached.
- ⛔ **SUPERSEDED 2026-09-14 — the record writer, un-sticking, reset-over-the-network
  and the make/model pickers ARE built now; see the section at the top of this file.**
  (Original line, kept as history:) ⏳ **NOTHING IN THIS SECTION IS BUILT.** Order that follows from it: (1) clean the
  three cross-tenant provisioning rows and settle whether all four phones really share
  ext 101; (2) re-run the stage-2 research, because "every possible way" cannot be built
  from memory; (3) then Phase D in his reset-first shape, Phase E, and the screens.
