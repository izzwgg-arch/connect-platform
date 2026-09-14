# ⛔ AGENT HANDOFF — the wizard finds PANASONIC phones now, and the PBX can NEVER provision one (2026-09-03) — READ FIRST before adding ANY vendor to `PHONE_MAKERS`, before "fixing" a Panasonic stuck on Needs attention, or for "the setup isn't detecting my phone"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md` §22**
(one commit on `feat/ivr-migration-takeover` — shared + desktop + api. Deploy state
recorded at the end of §22. No migration, no PBX write, no env change. Read-only PBX
check only.) Memory: [[panasonic-found-honestly-never-pbx-provisioned]].
Izzy, 2026-09-03, a KX-TGP500 on his desk: *"This phone is not on my network. The
automated test phone setup is not detecting it."* → *"full support."*

- ⛔⛔ **DETECTION AND PROVISIONABILITY ARE TWO QUESTIONS, and for Panasonic they
  answer opposite ways.** The wizard now recognises Panasonic three ways (OUIs
  `0080f0`/`080023` in the shared `VENDOR_PREFIXES`, `panasonic` in `PHONE_MAKERS`,
  KX-TGP/UT/HDV in the banner parser + `KIND_PATTERNS` — TGP500/600 cordless_base,
  TGP550/UT/HDV desk_phone). **But `provisioning.brands` on the live PBX has NO
  Panasonic brand** (20 brands, read-only check) — no template can ever exist, so
  `vendorSupportsPbxProvisioning()` (shared deviceKinds.ts) is false ONLY for
  panasonic and the advance route acts on it, route-level, in the exact shape of the
  `provisioningHandoffFailed` override — **the pure ladder and its 12.6M-decision
  invariant suite are untouched.**
- ⛔⛔ **A PANASONIC IS NEVER RESET AND NEVER ASKED FOR A PASSWORD.** Its only
  possible configuration is a hand-typed SIP account; a factory reset would erase
  the one thing that could make it work, with no way to re-provision after. Not
  registered → **halt → support immediately** ("Loopcom can't set this model of
  phone up automatically yet…") instead of stalling on `set_provisioning` forever.
  **Registered → REGISTERED outright**: the flip condition gained
  `(provisioningIsOurs || handConfiguredVendor)` because a hand-configured Panasonic
  can never point at our provisioning — demanding both leaves a working phone amber
  forever. ⛔ An UNKNOWN vendor stays provisionable=true on purpose — an
  unidentified device may be a locked Yealink and keeps the full ladder.
- ⛔ **The api's `lanPhoneVendors.ts` knowing Panasonic was a decoy** — it feeds the
  never-used lan-phones screen, not the wizard; the wizard reads
  `deskPhoneSetup/deviceIdentity.ts`. Two vendor lists, one live. Any NEW vendor
  added to `PHONE_MAKERS` must be checked against the PBX's `provisioning.brands`
  first, and denied in `vendorSupportsPbxProvisioning` if absent — or the wizard
  stalls forever / wipes a phone it cannot restore.
- ✅ **Proven:** shared 97/97, desktop phoneSetup 69/69 (real banner
  `Panasonic-KX-TGP500B04/22.116.0.10`, the maker-less web title), api routes 47/47
  + chaos/stress/order 50/50 (4 new: the support halt with resetCount 0 and no
  provisioningUrl leaked; registered→REGISTERED; unknown vendor keeps the ladder;
  OUI fill). Typechecks shared/desktop/portal 0, api 81 = baseline.
- ⏳ **NOT PROVEN: the physical KX-TGP500 has still never been SEEN on a network** —
  "not on my network" may be literal (the base is not PoE; check the router's DHCP
  table for a `00:80:F0` MAC before anything else). ⛔ The desktop banner parsing
  rides the NEXT installer (0.1.16 fingerprints it unknown; the server's OUI fill
  names the vendor anyway). ⛔ CONNECTING one stays a hand job (web UI via #534,
  credentials in `ombu_devices`) — once it registers, the wizard turns it green by
  itself; a Panasonic template renderer is a separate decision, device in hand.
