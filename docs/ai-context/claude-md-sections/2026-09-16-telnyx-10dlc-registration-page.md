# 2026-09-16 · TELNYX 10DLC REGISTRATION — MOCKUPS V3 AWAITING IZZY (customer link flow), NOTHING BUILT

Full handoff: **`docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md`** (§00 = revision 3 decisions + privacy research, §0 = revision 2)

- Izzy asked whether Loopcom can submit 10DLC to Telnyx: **it can't** — no Telnyx brand/campaign
  code exists. He asked for an Admin page, mockups first.
- ✅ **V2 mockups** (artifact https://claude.ai/artifact/UjnMidL2iSzitYgutQCvbk, Version 2; file
  `docs/mockups/telnyx-10dlc/index.html`): per-customer private link → copy, or the standard
  Loopcom email (real logo) → public pre-filled form in light/dark → customer sends → admin
  reviews → **"File with Telnyx"** button (automatic filing designed in, OFF).
- ⛔⛔ **Izzy's rule for the customer form: they SEE everything the system filled in but EDIT ONLY
  what we need from them** (legal name, EIN, business type, IRS address, website, signature,
  consent). Generated legal wording is read-only to customers, editable by admin on review.
- ⛔ Customer surfaces never name a carrier. Email = the `loopcomEmailShell` look, own EmailJob
  type, never ADMIN_ALERT.
- ⛔ The EIN must now be HELD until filing → proposed encrypted column, audited reveal, purged on
  brand verification or after 14 days. Awaiting approval.
- ⛔ Telnyx docs contradict its OpenAPI spec in 5+ places — build to the spec (handoff §2).
- ⛔⛔ Found: legacy `TenDlcSubmission.einEncrypted` is plain base64; the SMS Campaigns 10DLC gate
  can never open; the `/settings/sms-mode` LIVE gate reads only the legacy table.
- ✅ **Decided (V3):** EIN TOKENIZED (encrypted token, audited reveal, destroyed on brand
  verification); the ~$24 up-front charge goes on the CUSTOMER'S invoice. ⛔ Monthly fee and
  marketing DEFERRED — "don't say anything about that" — removed from every screen; add nothing
  about them until Izzy decides.
- ⛔ **Privacy policy (researched):** not a hard registry field, but TCR's own guide says a
  compliant policy is REQUIRED and reviewers reject without one — even for customer-texts-first.
  Telnyx: must be the BRAND's policy, never the reseller's. Plan awaiting OK: generate policy +
  SMS terms in the customer's legal name on a public Loopcom-hosted page; no-website customers
  give a Google Business/Facebook link. Hosting on the ISV domain is UNCONFIRMED with carriers.
- ⏳ Remaining open: privacy plan OK, auto-move texting to Telnyx, fix the two legacy gates.
  Nothing built, no Telnyx call made.
