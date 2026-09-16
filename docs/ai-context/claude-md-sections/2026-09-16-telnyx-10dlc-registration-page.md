# 2026-09-16 · TELNYX 10DLC REGISTRATION ADMIN PAGE — MOCKUPS AWAITING IZZY, NOTHING BUILT

Full handoff: **`docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md`**

- Izzy asked whether Loopcom can submit 10DLC to Telnyx: **it can't** — no Telnyx brand/campaign
  code exists. He then asked for it built end to end as a new Admin page, **mockups first**.
- ✅ Mockups published: `docs/mockups/telnyx-10dlc/index.html`, artifact
  https://claude.ai/artifact/UjnMidL2iSzitYgutQCvbk (V1). 12 screens: board, 4-step wizard with
  live carrier-rule checks, itemised charge confirm, per-carrier detail, reject/appeal +
  brand fix, sole-prop PIN, requests-to-drafts, settings/health, permission keys, decisions.
- ⛔ Telnyx's docs contradict its OpenAPI spec in 5+ places (vetting path, assignment path,
  campaign create path, appeal, webhook shape) — **build to the spec** (handoff §2).
- ⛔⛔ Found in passing: the legacy `TenDlcSubmission.einEncrypted` is **plain base64**; the SMS
  Campaigns page 10DLC gate **can never open** (shape mismatch); `/settings/sms-mode` LIVE gate
  reads only the legacy table.
- ⏳ **Blocked on Izzy's six decisions** (EIN storage, who pays fees, staff-only, auto-move
  texting to Telnyx, sole-prop PIN method, fix the two gates). Nothing built, no Telnyx call made.
