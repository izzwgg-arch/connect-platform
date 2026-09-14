# ⛔⛔ AGENT HANDOFF — the Desk Phone Wizard identifies what it discovers and drives maker clouds through one provider interface; BUILT + COMMITTED, NOT DEPLOYED, migration NOT applied, no GDMS credential (2026-09-14) — READ FIRST before touching `apps/api/src/deskPhoneSetup/device*.ts` / `gdms*.ts` / `grandstreamProvider.ts`, `packages/shared/src/deskPhoneSetup/deviceIdentification.ts`, or before storing GDMS credentials

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEVICE_IDENTIFICATION_2026-09-14.md`**.
Memory: [[desk-phone-device-identification-built]].

- **Rule served:** the wizard asks "what device did we discover?", never "what brand did the customer pick?".
- **Identification** (`identifyDevice`, shared, pure): maker from MAC OUI only; model from multi-source evidence
  (vendor cloud > PBX record > device API > SIP UA > HTTP banner > label > manual) with confidence, conflicts reported;
  device types desk/video/ata/door/intercom/conference/cordless/gateway/paging/other/unknown; capabilities only as a
  provider reports them.
- **Providers:** Grandstream GDMS = lookup/claim/reboot/reset/status (live-capable, field names UNVERIFIED on a real
  account); Yealink RPS = lookup only; Fanvil + Poly = `not_supported`. GDMS simulator is test-only (import guard +
  `GDMS_MODE=test` refused).
- **Safety:** foreign run/device = 404; cross-tenant MAC = conflict; claims serialised on an advisory lock; factory reset
  never automatic, needs reset permission + per-phone approval, spent atomically BEFORE the maker call, given back only
  on a definite refusal.
- **Migration** `20260914190000_desk_phone_identification` (six nullable columns + macAddress index) — NOT applied.
- **Desktop** (next installer): Poly + extra Grandstream/Yealink families named; fingerprints carry their source; one
  unauthenticated Grandstream `phone_model` read only for pages that already say Grandstream (flood cap).
- **Portal:** card shows device type + MAC · IP; "type or scan what the label says" beside the make/model fallback —
  built WITHOUT a mockup review.
- ⛔ **Open, Izzy's call:** reset-first rule vs capability-driven `/prepare`; storing GDMS credentials (Admin → GDMS,
  never chat) + first read-only Verify/lookup; deploy api+portal; desktop installer.
