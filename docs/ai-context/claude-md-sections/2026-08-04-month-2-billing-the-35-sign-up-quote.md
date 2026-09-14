# AGENT HANDOFF — month-2 billing = the $35 sign-up quote (2026-08-04) — READ FIRST for recurring-invoice, telecom-fee, or onboarding-billing work

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_MONTH2_BILLING_2026-08-04.md`**

- **Every onboarding-created/adopted tenant gets billing stamped** by
  `ensureOnboardingBillingDefaults` (`apps/api/src/onboarding/onboardingBillingDefaults.ts`,
  deployed `aafcc2f7`): `taxEnabled` on + `metadata.billingTelecomFees` = E911 $3
  per number, flat $2 regulatory, **salesTax explicitly disabled** (the $30/ext
  price already includes tax — never add a percentage on top for these tenants).
  Guards: skips any tenant with existing fee config or taxEnabled; re-runs no-op.
- ⛔ **E911 must stay on basis `per_phone_number`, not `per_did`**: `per_did`
  counts only billable numbers (0 for a one-number tenant with first-number-free),
  and onboarding numbers exist ONLY in `PbxTenantInboundDid` — never the Connect
  `phoneNumber` table. The engine feeds `max(table total, active PBX DIDs)`.
- Fee lines only build when `settings.taxEnabled` is true — a stamped config
  with taxEnabled false bills $0 in fees. Regression: month-2 preview must equal
  the quote to the cent (`onboardingBillingDefaults.test.ts`, $35/$45-with-SMS).
- Test-mock gotcha: `invoiceEngine` imports cache against the FIRST
  `mock.module("@connect/db")` — use one shared mutable mock per test file.
- Pre-fix paid sign-ups: `pnpm exec tsx scripts/backfill-onboarding-telecom-fees.ts`
  (apps/api; dry-run default). Zero existed at deploy time.
- Toll-free/vanity (unmerged `73f990a0`) will ride the `customFee` slot of the
  SAME billingTelecomFees object — it must MERGE into an existing config, not
  re-call the stamp (the guard makes a second stamp a no-op).
