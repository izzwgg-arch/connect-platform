# AGENT HANDOFF — payment links: copy anywhere, text from Connect's number, one link for ALL open invoices (2026-08-10 → 08-12)

Branch `feat/ivr-migration-takeover`. **Everything below is DEPLOYED and
container-verified** — api at `86d219f8`+, portal live with the new bundle.

| commit | what |
|---|---|
| `c3c3a9a1` | copy a payment link + text one from Connect's own number |
| `504ec6ed` | (swept in from another session: team-directory scroll fix) |
| `9f669f79` | ONE payment link covering every open invoice of a customer |

---

## 1. The dead button, and why it could never have worked

The invoice screen's "Text payment link" button had TWO stacked faults:

1. **It posted an empty body** to `POST /admin/billing/invoices/:id/sms-payment-link`,
   which requires a destination phone — every click 400'd, and the old screen
   swallowed the message.
2. **The route resolved the SENDER from the customer's tenant** — it needed a
   `ProviderCredential` row AND an active `phoneNumber` row on that tenant.
   Onboarding customers have **neither** (their numbers live in
   `PbxTenantInboundDid` / `TenantSmsNumber`), so even with a phone typed in,
   every send answered `sms_provider_unavailable`. And on the tenants where it
   *would* have worked, it would have texted a Connect bill **from the
   customer's own number** — worse than failing.

## 2. THE RULE: billing texts are sent BY CONNECT, not by the customer

One from-number for every customer, present and future: **(845) 723-1213**.

- `apps/api/src/billing/billingSmsSender.ts` owns it:
  `resolveBillingSmsFromNumber()` reads `BILLING_SMS_FROM_NUMBER` **at call
  time** and falls back to the hardcoded `+18457231213`, so a container missing
  the env still behaves. Credentials are the **platform** VoIP.ms account
  (`GlobalVoipMsConfig`, same as Connect Chat texting) — never per-tenant.
- ⛔ **`BILLING_SMS_FROM_NUMBER=8457231213` had been set in production env
  (api AND worker containers) with ZERO readers in the codebase.** Izzy
  remembered configuring it; nothing was wired to it. Before believing a
  setting does anything, `git grep` its name — presence in the container
  proves nothing.
- ⛔ **`fromPhone` in the POST body is still accepted and deliberately
  IGNORED** — the old invoices screen (`adminBillingOpsPanels.tsx`) still sends
  it, and an operator must never text a customer their bill from another
  customer's number. The sms-capability route now returns exactly one
  from-number choice.
- The sender honors `SMS_PROVIDER_TEST_MODE` (only an explicit `"false"` sends
  for real — api has `false`, the platform env file's `true` is overridden in
  compose) and splits long bodies with `splitVoipMsSendSmsParts` (the carrier
  rejects over-long single parts rather than splitting).
- Guard tests: `billingSmsSender.test.ts` — 11 cases, including "the sending
  number must not vary by customer".

## 3. Copy-paste link

`GET /admin/billing/invoices/:id/payment-link` (SUPER_ADMIN) returns:

- `url` — the SAME signed public pay URL the emails use
  (`billingInvoicePublicPayUrl`, 30-day HMAC token, no login to open);
- `expiresAt`;
- `sms { capable, fromNumber, fromNumberLabel, reason, suggestedPhone }` —
  everything the "text it" panel needs in one call. `suggestedPhone` is the
  last number successfully texted for this tenant (from
  `billing.sms_payment_link_sent` event metadata);
- `combined` — see §4. Null when the customer has fewer than 2 open invoices.

The invoice screen (`admin/billing/invoice/[id]/page.tsx`) grew a **Payment
link card** (dead button removed): the link + Copy button, and a phone field
prefilled with `suggestedPhone`, stating it sends from Connect (845) 723-1213.

## 4. ONE link that covers every open invoice

When a customer owes on 2+ invoices (`OPEN|FAILED|OVERDUE`, `balanceDueCents > 0`),
the card offers **"Just this invoice ($X)" vs "All N open invoices ($Y)"** —
the toggle drives both Copy and the text. The SMS route takes
`combined: true` (400 `combined_not_applicable` if only one invoice is open)
and stamps the `billing.sms_payment_link_sent` event on **every covered
invoice**, plus `lastEmailStatus: SMS_SENT` on each.

**Token**: `createBillingMultiPayToken` / `verifyBillingMultiPayToken` in
`billingPayToken.ts` — payload `{t, ii: [invoiceIds], e}` vs the single's
`{i, t, e}`. ⛔ **The two verifiers reject each other's tokens** (asserted in
`billingPayToken.test.ts`); never "unify" them into one lenient verifier.

**Public page**: `/pay/invoices/[token]` (`apps/portal/app/pay/invoices/`),
sibling of the single page, same CSS + `CardknoxIFieldsForm`. Lists every
invoice with its balance; one card entry; result reported **PER INVOICE** —
never a single green check that could hide a half-success.

**Charge flow** (`publicPayRoutes.ts`, `pay-multi/:token/pay`) — deliberately
reuses the per-invoice machinery instead of inventing a combined charge:

1. The card form's single-use SUT becomes a **reusable gateway token** inside
   `chargeBillingInvoiceWithSut` (`saveCardWithSut` → `xToken`). First invoice
   (oldest due date) charges through it with `persistPaymentMethod: true` —
   the save is what mechanically lets invoices 2..n charge without re-entering
   the card.
2. Remaining invoices charge via `chargeBillingInvoice` with the saved
   `PaymentMethod` row, due-date order. Every invoice keeps its own
   `PaymentTransaction`, receipt email, dunning clear, and timeline events
   (`payment.public_pay_succeeded/declined` with `combined: true`).
3. ⛔ **If the customer did not tick "save my card", the method is deactivated
   (`active:false, isDefault:false`) the moment the run ends** — it was only
   saved to carry the run. A `payment_method.removed` event records why.
4. `enableAutopay` upserts `tenantBillingSettings` exactly like the single
   page (upsert, not update — new tenants have no row).

**Honesty rules baked in — do not "optimize" them away:**
- First-charge decline → **nothing else attempted**, card not saved
  (`storeSolaPaymentMethod` only runs on approval), rest reported
  `not_attempted`.
- A later decline → **stop charging the rest** (one decline is enough;
  hammering a failing card burns gateway attempts and risks velocity blocks).
- `INVOICE_ALREADY_PAID` → `skipped_already_paid`;
  `BILLING_PERIOD_ALREADY_PAID` → `skipped_period_covered` with the covering
  invoice named. Both count as settled, not failures.
- `allSettled` is true only when every result is paid/skipped-as-covered.

⛔ **The adjacent-month period-guard worry is settled — from production data,
not reasoning.** LUZER's July invoice ends 08-05 and August starts 08-05;
`findPaidBillingPeriodCoverage`'s overlap is inclusive, so on paper paying July
would block August. In practice Gesheft, Trimpro and Solidify all have
consecutive months paid ON the boundary day — the guard demonstrably does not
fire there. Where it does fire, it is protecting against a genuinely
double-billed period, and the flow reports it honestly instead of fighting it.

## 5. Deploy notes from this engagement

- **The api deploy that shipped `9f669f79` was enqueued by ANOTHER session**
  (branch tip `86d219f8` — tips carry everyone's work; that is why you deploy
  the TIP, never pin your own commit).
- **My portal deploy self-skipped**: `skip=unrelated_paths` comparing the
  running container to the tip. ⛔ That skip is only trustworthy if you verify
  the running container is a **descendant of your commit** —
  `git merge-base --is-ancestor <yours> <container-commit>` — AND grep the live
  `.next` for your strings. Both checked: `80ec63ba` contains `9f669f79`;
  `pay-multi` and the new UI strings are in the live bundle.
- ⛔ **Hit the documented `pgrep -f` self-match trap AGAIN** (a waiter greping
  `run-heavy.sh deploy-queue` matched its own bash -c command line and would
  have hung forever). It is in CLAUDE.md three times. Poll
  `/ops/deploy/status` `runningCount` instead.

## 6. Live facts (verified on prod 2026-08-10/12)

- `TenantSmsNumber` +18457231213: Connect Communications tenant
  (`cmqzfigij4bt0mw13u2ulpd0t`), active, smsCapable; VoIP.ms `sms_enabled: 1`,
  routing `account:344022_loopcom`.
- Customers with 2+ open invoices today: **Landau Home** (2 × one_time_charge,
  $501 — same-day periods, guard-safe: one_time_charge without "monthly
  service" text never triggers coverage) and **LUZER** (2 × FAILED, $90).
- Tests: `test:billing` green (421 pass / 0 fail); token tests 6/6; sender
  tests 11/11. Typecheck clean both apps.

## 7. ⏳ NOT PROVEN — the honest gaps

1. **No text has EVER gone out from (845) 723-1213** — zero
   `connectChatThread` rows on that number. The carrier says texting is on;
   the first real send is the only proof. Text yourself before a customer.
2. **No combined payment has run against the real gateway.** The flow is
   proven by tests and by reusing the two most exercised charge functions in
   the codebase — but nobody has entered a card on `/pay/invoices/<token>` and
   watched two invoices settle. LUZER ($90, two FAILED invoices) is the
   natural first live case.
3. The single-invoice page's "text it" panel had also never been used at
   handoff time — same first-send caveat.
