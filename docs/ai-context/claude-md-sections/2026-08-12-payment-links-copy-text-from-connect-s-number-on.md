# ⛔ AGENT HANDOFF — payment links: copy, text from Connect's number, one link for ALL open invoices (2026-08-12) — READ FIRST for billing SMS, pay-link work, or before touching the sms-payment-link route or billingPayToken

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_PAYLINK_SMS_2026-08-12.md`**
(`c3c3a9a1` + `9f669f79` on `feat/ivr-migration-takeover`, api + portal
**DEPLOYED and container-verified**.)

- ⛔ **THE RULE: a billing text is sent BY CONNECT, not by the customer.** One
  from-number for every customer, present and future: **(845) 723-1213**, via
  `billingSmsSender.ts` + the platform VoIP.ms account (`GlobalVoipMsConfig`).
  The old route resolved the sender from the CUSTOMER's tenant — needed
  `ProviderCredential` + an active `phoneNumber` row, which onboarding
  customers never have — so every send failed `sms_provider_unavailable`; and
  the screen's button posted an empty body, so it 400'd before even that.
  ⛔ `fromPhone` in the POST body is accepted and deliberately IGNORED.
- ⛔ **`BILLING_SMS_FROM_NUMBER` sat in prod env (api + worker) read by
  NOTHING.** Before believing a setting is wired, `git grep` the name —
  presence in the container proves nothing.
- **Copy link**: `GET /admin/billing/invoices/:id/payment-link` → the signed
  public pay URL (30-day token) + texting state + `combined` in one call. The
  invoice screen's Payment link card copies or texts either kind.
- **Combined link** (`9f669f79`): 2+ open invoices → one link, one card entry,
  each invoice charged oldest-first through the EXISTING per-invoice machinery
  (SUT → reusable xToken → first via `chargeBillingInvoiceWithSut`
  persist-card, rest via `chargeBillingInvoice`; card deactivated after unless
  the customer kept it). Result reported PER INVOICE. ⛔ First-charge decline
  stops everything; a later decline stops the rest; `BILLING_PERIOD_ALREADY_PAID`
  is an honest "already covered" skip, never an error. ⛔ The single and multi
  pay tokens are different shapes and the verifiers reject each other — never
  merge them. ⛔ Adjacent-month boundary overlap does NOT trip the period guard
  (proven from prod: Gesheft/Trimpro/Solidify paid on boundary days).
- ⏳ **NOT PROVEN**: no text has ever gone out from (845) 723-1213 (zero
  threads on that number — first real send is the acceptance test), and no
  combined payment has run against the real gateway. LUZER (2 × FAILED, $90)
  is the natural first live case.
