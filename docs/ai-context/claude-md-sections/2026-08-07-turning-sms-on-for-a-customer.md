# ⛔ AGENT HANDOFF — turning SMS on for a customer (2026-08-07) — READ FIRST for "activate texting", SMS number assignment, or any "their texts aren't arriving" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full runbook (incl. paste-ready wording for the Connect Agent's knowledge):
**`docs/ai-context/AGENT_HANDOFF_SMS_ACTIVATION_2026-08-07.md`**. Proven end to
end on **inii mini** 2026-08-07 — real text out ("Message delivered to handset")
and a real reply into the customer's inbox. No deploy, no PBX write, no Apply
Changes.

- **The whole job is four steps:** (1) find the DID's `TenantSmsNumber` row —
  every VoIP.ms DID syncs in with `tenantId: null` (69 rows, 59 unassigned);
  (2) assign it (`PATCH /admin/apps/voip-ms/numbers/:id` or Admin → VoIP.ms
  numbers) with `tenantId` + `assignedExtensionId` (or `assignedUserId`, or
  neither for a shared company inbox) + `isTenantDefault`; (3)
  `TenantBillingSettings.smsBillingEnabled = true` — `smsPriceCents` is already
  1000 on every onboarding tenant, so the next invoice moves $35 → $45, nothing
  charges mid-cycle; (4) confirm `sms_enabled: "1"` on the DID at VoIP.ms
  (`setSMS {did, enable:"1"}` if not; expect `sms_wait_message` rate-limiting).
- ✅ **DONE for Create A Box ext 102 (8457826722) 2026-08-18 — inbound PROVEN with
  real texts, and only ONE of the four steps was actually needed.** `sms_enabled`
  already read **"1"** at the carrier, so step 4 was a no-op; the whole job was the
  `TenantSmsNumber` assignment (row `cmogdrtku0085pk5eiusjeaba` → tenant
  `cmnlgryox001ip9paov24bmr0`, `assignedExtensionId` = ext **102 "Sender Weiss"**,
  tenant default, active) through the real `PATCH /admin/apps/voip-ms/numbers/:id`
  driven by a 60-second self-signed SUPER_ADMIN token against `127.0.0.1:3001`.
  ⛔ **Read `getDIDsInfo` BEFORE writing anything** — a DID that has been on the
  account for years may already be armed, and `setSMS` is rate-limited, so a
  reflexive write buys a `sms_wait_message` and nothing else.
  ✅ Proven, not inferred: the number joined the poll on the very next cycle
  (`[voipms-inbound] +18457826722: fetched=7`) and **7 real inbound texts landed**
  on a thread whose `smsInboxOwnerUserId` is **senderweiss@gmail.com** — which is
  the entire point of pointing a number at an extension rather than the tenant.
- ⛔⛔ **`sms_email` IS A SECOND, INVISIBLE DELIVERY PATH, AND IT IS LIVE ON THIS
  NUMBER — Create A Box's texts have been going to `izzwgg@gmail.com` all along.**
  `getDIDsInfo` reads `sms_email: "izzwgg@gmail.com"` with `sms_email_enabled: "1"`
  — a carrier-side forward that predates Connect's inbox and was **left untouched**.
  ⛔ Do NOT lump it in with the red-herring `webhook_enabled` flag above: that one
  correlates with nothing, this one demonstrably delivers. **Read `sms_email` on
  every activation** — a customer's texts landing in someone's personal mailbox is
  a privacy question, not a config detail, and switching it off is Izzy's call.
- ✅ **DONE for B Visible 2026-08-20 — SHARED company inbox on (845) 238-0478,
  inbound PROVEN with real texts** (runbook §8). One write again:
  `TenantSmsNumber cmogdrtg2007lpk5eeo1cunpw` → tenant
  `cmnlgryp8001lp9pajhatv3t9`, **assignedExtensionId AND assignedUserId both
  null = shared inbox** (all 5 users see it), tenant default, through the real
  PATCH route. Carrier already read `sms_enabled: "1"` (routing
  `account:344022_bvb2`) — no carrier write, third customer in a row where
  step 4 was a no-op. Next poll cycle: `[voipms-inbound] +18452380478:
  fetched=5` → five threads, **every one `smsInboxOwnerUserId` empty** (the
  shared shape), incl. a Home Depot text from shortcode `53747`. ⛔ **Billing
  NOT enabled — needs Izzy**: B Visible is on the flat $105 (extensions only,
  [[flat-rate-inverts-the-extension-billing-rule]]), so `smsBillingEnabled`
  would ADD a $10 `SMS_PACKAGE` line — the same question Create A Box got;
  left false pending his word. ⛔ `sms_email` forwards every inbound text to
  **sales@bvisible.us** (their OWN mailbox this time) — left alone, so texts
  land in BOTH places. ⛔⛔ **UPDATE 2026-08-24: Connect's own SMS-to-email is
  now OFF for all 5 B Visible users (see the SMS↔email bridge section), so this
  carrier forward — plus `sms_forward: 8456626794`, which re-texts every inbound
  message — is the ONLY remaining reason they still get texts by email. Neither
  was touched; both need Izzy.** Their other two numbers (866-579-7575 toll-free,
  845-776-1311) stay unclaimed on purpose. ⏳ Not proven: no outbound text yet.
- ⛔⛔ **CREATE A BOX TEXTS FOR FREE, BY IZZY'S DECISION (2026-08-18) —
  `smsBillingEnabled` is `false` ON PURPOSE and must not be "fixed".** Asked
  whether to bill the $10, his answer was *"turn it on without charging"*: they
  keep the negotiated **flat $130/mo** and get texting at no extra charge.
  ⛔ **The switch is BILLING-ONLY and gates nothing** — every reader is the invoice
  engine, `billing/usage.ts`, the billing routes, or a readout (`agentTenantFacts`,
  `accountSetupInfoRoute`); **no code path gates messaging on it**, which is why
  texting demonstrably works today with it off. Flipping it adds a $10
  `SMS_PACKAGE` line and takes them to **$140**, because ⛔ **the flat rate covers
  EXTENSIONS ONLY and does not absorb the SMS line**
  ([[flat-rate-inverts-the-extension-billing-rule]]). Their July invoice
  `CC-202607-00015` is separately sitting **FAILED** at $130 — unrelated, untouched.
  ⛔ **One latent consequence to know about:** `portLanding.ts:336` moves texting
  onto a ported number only when `smsBillingEnabled` is on **or** the temp number
  already carries a claimed row — so if this number is ever ported, that branch
  skips it and the texting has to be moved by hand.
- ⛔ **The per-DID `webhook` / `sms_url_callback` fields are a red herring, and
  `setSMS` lies about them.** It answers `{"status":"success"}` and NEVER moves
  either `_enabled` flag (four param shapes tried). **Gesheft is the busiest
  inbound SMS number on the platform with `webhook_enabled: "0"` and a stale
  3CX URL.** Judge from a number that demonstrably works, never a field name.
- ⛔ **Three more non-requirements:** `smsSendMode` stays **TEST** (LIVE is the
  old campaign path — it reads the `phoneNumber` table, which onboarding tenants
  have ZERO rows in); `defaultSmsFromNumberId` stays null (`isTenantDefault` on
  the number row is the real setting); `smsPrimaryProvider` reads TWILIO on every
  working tenant and must not be "fixed" — chat texting rides VoIP.ms regardless.
- **Inbound arrives by POLL, not the webhook.** `voipMsInboundSyncJob.ts` polls
  `getSMS`+`getMMS` for every assigned/active/smsCapable number — assignment IS
  the wiring; watch `[voipms-inbound] +1…: fetched=N` in the worker log. ⛔ Never
  conclude "nothing arrived" from nginx (`/api/webhooks/voipms/sms` is rarely
  hit), and ⛔ never measure delivery lag from the DB — inbound `createdAt` is
  stamped from the **carrier's** timestamp, so it can only ever agree with itself.
- ✅ **inii mini's port LANDED 2026-08-12 and is FULLY LIVE** (order 217760).
  The real number 646-984-6023 arrived routed to the MASTER account with SMS
  off — fixed same day: routed to `344022_iniimi92gh2m`, `sms_enabled=1`,
  TenantSmsNumber assigned + made tenant default (worker poll numbers=12).
  Calls: inbound route 240 created via panel automation (same code path as
  onboarding), switched to Connect via the real `/voice/did/:id/switch-to-connect`
  + full publish (183 keys) — probe call traced into `connect-menu` playing
  `custom/main_greeting_fc10c9`. ⛔ **The switch only worked after restarting
  `connect-pbx-helper` on the PBX** — it had wedged at 1024/1024 FDs + 761
  threads (`pbx_helper_read_failed: aborted due to timeout` on every switch
  platform-wide). Root-caused + FIXED same day: helper `2026.08.12.1`
  (bounded server, spool-scan cache, LimitNOFILE 65536) — see
  [[pbx-helper-fd-leak-wedges-switches]]. ✅ **Temp number 845-260-5692 was
  RETIRED automatically** by the port watchdog's first sweep (back on the
  master spare pool, SMS row un-claimed, mapping deleted); its old "Main"
  PBX inbound route on tenant 105 is the one leftover (+$3/mo E911 until
  deleted in the panel). See the port-automation handoff at the top of this
  file and [[voipms-sms-per-did-webhook-is-a-red-herring]].
