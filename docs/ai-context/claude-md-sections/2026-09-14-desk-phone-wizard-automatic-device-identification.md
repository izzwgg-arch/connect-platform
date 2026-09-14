# ⛔⛔ AGENT HANDOFF — the Desk Phone Wizard identifies what it discovers and drives maker clouds through one provider interface; RESET-FIRST governs Prepare Device too; GDMS card on Admin → Integrations (2026-09-14, round 2 `acb994a3`) — READ FIRST before touching `apps/api/src/deskPhoneSetup/device*.ts` / `gdms*.ts` / `grandstreamProvider.ts`, `packages/shared/src/deskPhoneSetup/deviceIdentification.ts`, or before storing GDMS credentials

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEVICE_IDENTIFICATION_2026-09-14.md`**.
Memory: [[desk-phone-device-identification-built]], [[reset-first-is-izzys-decision-cost-stated]].

- **Rule served:** the wizard asks "what device did we discover?", never "what brand did the customer pick?".
- **Identification** (`identifyDevice`, shared, pure): maker from MAC OUI only; model from multi-source evidence
  (vendor cloud > PBX record > device API > SIP UA > HTTP banner > label > manual) with confidence, conflicts reported.
- **Providers:** Grandstream GDMS = lookup/claim/reboot/reset/status (field names UNVERIFIED on a real account);
  Yealink RPS = lookup only; Fanvil + Poly = `not_supported`. GDMS simulator is test-only.
- ⛔⛔ **Reset-first (Izzy, round 2: "reset every time you connect the phone"):** `planDevicePreparation` clears every
  TICKED phone not yet reset in this setup BEFORE reprovision/reboot/SIP. Never: registered to us, held by another
  account, unknown model, no settings profile. Unticked → nothing at the maker at all. `/prepare`: tick = consent (no
  separate reset-permission gate, same as the ladder); reset is the last step of that request; spent atomically first,
  given back only on a definite refusal.
- **GDMS card:** Admin → Integrations → "Grandstream device cloud (GDMS)": Save (write-only), Verify, Clear, read-only
  Look up by MAC (`POST /admin/desk-phones/gdms-credentials/lookup`). ⛔ There is no "Admin → GDMS" page.
- **Migration** `20260914190000_desk_phone_identification` (six nullable columns + macAddress index).
- **Desktop** (installer): Poly + extra families named; one Grandstream `phone_model` read only for Grandstream pages.
- **Portal:** card shows device type + MAC · IP; "type or scan what the label says" box — built WITHOUT a mockup review.
- ✅ **DEPLOYED + container-verified 2026-09-14:** api 19:13Z and portal 19:22Z, both `acb994a3`, 0 restarts;
  migration `20260914190000` applied (six columns present). ✅ Desktop `0.1.17-rc.14` built from a clean export of
  `f8e11424` and INSTALLED on Izzy's PC — ⛔ NOT published (feed stays rc.10).
- ⛔⛔ **Round 3 (`7e54716a`, DEPLOYED api+portal 2026-09-14 ~21:00Z): PER-BRAND MECHANISMS.** Shared
  `deviceMechanismsFor(vendor, readiness)` is the ONE answer for how a brand is cleared / restarted / given
  settings. `/advance` adds `via:"vendor_cloud"` from it; the driver listens first, then runs the step through
  `/prepare` (GDMS claim → reset; later a GDMS restart, ≤2, 3 min apart; one cloud ask per 30 s). Serial screen;
  one read-only maker-cloud lookup for unnamed phones. Other brands unchanged. Why: Izzy's 20:13Z run — a ticked
  GXP2170 was told "reset over LAN", skipped it, and waited for a power-cycle while GDMS sat unused. Handoff §10b.
- ⛔⛔ **Round 4 (`c7f5459c`, desktop rc.15): GRANDSTREAM RESETS OVER THE LAN WITH THE PASSWORD, no serial.**
  New `apps/desktop/src/phoneSetup/grandstream.ts` (session `dologin` → `api-sys_operation REBOOT|RESET`);
  `deviceMechanismsFor` prefers `lan_http` reset over the serial-based GDMS reset. Settings stay on PnP (no
  Grandstream HTTP config write, no P237 trap). Handoff §10c. ⏳ The authenticated write is UNPROVEN on a real
  handset — Izzy types the phone password into the wizard once; a wrong shape fails safe to the PnP power-cycle.
- ⛔⛔ **Round 5 (THIS ROUND): THE PASSWORD PROMPT IS GONE — the serial is asked ONCE, on the
  extension screen.** Izzy: *"I don't want it to ask for the password … where they select the
  extension, they should also be prompted to enter the serial number."* So round 4's precedence is
  **INVERTED ON PURPOSE**: `deviceMechanismsFor` returns `reset:"vendor_cloud"` primary and
  `resetFallback:"lan_http"` (the password) second, for a brand with a connected wiping cloud.
  ⛔ `/advance` converts **all three shapes** of the ladder's password question —
  `try_default_credentials`, `ask_for_password`, and the `halt` it returns on `passwordUnavailable` —
  into the cloud route, gated on: reset unspent, ticked+approved, not registered to us, and
  `makerCloudUnavailable !== true`. Both doors shut still ends at the honest hands-on halt.
  `customerPhoneView` gained `serialOnFile`; the match step shows a serial box (+ the sticker
  drawing) only when it is false, and `supplySerial` re-reads the run so the box removes itself.
  ⛔ The LAN/password path is NOT deleted — it is the fallback, and is what a Grandstream with no
  cloud still uses (desktop rc.16 login shape unchanged).
- ⏳ **NOT PROVEN (round 5):** no customer has typed a serial on the extension screen, and no phone
  has been cleared through GDMS from one. Parts 2 and 3 of Izzy's flow — **upload a photo** of the
  label, and **text the photo** to the business number (prompt for the sending number, read the chat
  once, refuse a blurry picture on OCR confidence) — are **NOT BUILT**, and are inert until
  `CRM_OCR_ENABLED=true` on the api, which is Izzy's call (engine + language host already verified).
- ⏳ **NOT PROVEN:** GDMS credential IS saved (round 2 Verify passed), but no real reset yet (Izzy enters it on the card → Verify → Look up `C0:74:AD:8C:60:5F`);
  GDMS field names unverified; no real phone has gone through reset-first Prepare Device; neither screen seen in a browser.
