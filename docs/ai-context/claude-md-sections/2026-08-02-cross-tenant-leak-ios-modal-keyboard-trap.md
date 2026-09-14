# ⛔ AGENT HANDOFF — cross-tenant leak + iOS modal keyboard trap (2026-08-02) — READ FIRST for CDR tenant attribution, contacts, or any iOS modal

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CROSS_TENANT_LEAK_2026-08-02.md`**

- ⛔ **Calls were being written into OTHER COMPANIES' call history.** PBX-verified
  over 7 days: 3,517 matched records, **116 filed under the wrong company (3.3%)**,
  11 real customers, both directions — recordings ride along on the record.
  100% came through `tenantResolutionSource = telephony_connect_tenant_id`, which
  **trusted a caller-supplied tenant id outright**. Fixed `05952fb5` + `d6c657ff`
  (API) and `bfaed99e` (telephony). 116 records corrected; reversal at
  `loopcom:/root/cdr_refile_backup_2026-08-02.json`.
- **THE PBX IS THE SOURCE OF TRUTH.** Asterisk stamps the owner into the call
  (`dcontext T102_cos-all`, `PJSIP/T102_101_1-…`) and it cannot be forged.
  Attribution order: **PBX marker → the DID the PBX routed on → the claim (last
  resort only)**. A claim that disagrees is REJECTED. Conflicting markers resolve
  to NOTHING rather than picking a side. **Fail closed** — unattributed is
  recoverable, wrong-company is not.
- ⛔ **A React Native `<Modal>` is its own view hierarchy — this bit 3× in one
  session.** A screen-level `KeyboardAvoidingView` cannot reach inside it (every
  bottom-anchored sheet with an input needs its OWN, iOS-only). A ScrollView does
  not save you if the scroll area is itself under the keyboard. And **`showToast`
  is drawn BEHIND a modal** — use `showAppAlert` inside modals, or failures are
  silent by construction (this made "Open SMS thread does nothing" unexplainable
  for two builds).
- **Check the account can do the thing before debugging the app.** "SMS does
  nothing" was `TenantSmsNumber` having no row for the tenant → 400 every time.
  Two builds were spent on real-but-unrelated UI bugs first.
- **Sanity-check every audit query against the table total.** A voicemail check
  joined on extension NUMBER (not unique across tenants), fanned out, and reported
  30,000+ phantom leaks — more rows than the table holds. Voicemail is CLEAN:
  0 of 34,094.
- iOS: the pre-wake was reporting a **second CallKit call** per call (different id
  → different call identity) — that is the green pill / hang-up-twice. Disabled
  `18fedd9d`. Contacts 1,000-row cap + duplicate-that-named-nobody fixed
  `6e07adfe` + `bab31854`. iOS builds this session: 46 → 51.
