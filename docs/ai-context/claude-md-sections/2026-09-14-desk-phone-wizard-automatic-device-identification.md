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
- ⏳ **NOT PROVEN:** no GDMS credential saved yet (Izzy enters it on the card → Verify → Look up `C0:74:AD:8C:60:5F`);
  GDMS field names unverified; no real phone has gone through reset-first Prepare Device; neither screen seen in a browser.
