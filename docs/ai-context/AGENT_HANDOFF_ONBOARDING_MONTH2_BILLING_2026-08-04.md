# AGENT HANDOFF — Month-2 billing now equals the $35 sign-up quote (2026-08-04)

Session scope: the recurring monthly invoice engine knew nothing about the
sign-up quote's E911 and telecom-fee lines, so every onboarding customer's
SECOND bill would have silently dropped from the promised "$35 a month,
including tax" to a bare $30/extension. Fixed, tested, deployed (`aafcc2f7`,
api deploy job `12602a89`, healthy) before the Sept 1 billing run. Production's
current tip contains it.

## The gap this closed

- The FIRST invoice is built line-by-line from `quoteOnboarding`
  (`packages/shared/src/onboardingPricing.ts`): $30/ext tax-included + $3 E911
  per number + flat $2 "Telecom & regulatory fees" (+ $10 SMS if chosen).
- Every LATER invoice comes from `apps/api/src/billing/invoiceEngine.ts`, which
  bills from `TenantBillingSettings`: extensions default to the right $30, but
  E911/regulatory fees exist ONLY if `metadata.billingTelecomFees` says so —
  and fee lines only build at all when `taxEnabled` is true (default false).
  Onboarding stamped nothing → month 2 = $30, promise broken.

## What ships it

`ensureOnboardingBillingDefaults` (**`apps/api/src/onboarding/onboardingBillingDefaults.ts`**)
stamps every tenant onboarding creates or adopts:

- Called from BOTH tenant paths: `ensureTenantForSubmission` in
  `onboardingPayment.ts` (checkout creates the tenant; also self-heals on
  revisit) and `setupOrchestrator.ts` right after `ensureConnectTenant`/billing
  adoption (covers the auto-sync-race tenant and fresh creates).
- Stamps: `taxEnabled: true` + `metadata.billingTelecomFees` with E911 $3 on
  basis `per_phone_number`, regulatory flat $2, and **salesTax explicitly
  DISABLED** — the $30 already includes tax; a percentage on top would
  double-charge it. Wizard's SMS choice → `smsBillingEnabled: true` (only ever
  switched on).
- **Guards (why this can't hurt existing tenants):** skips any tenant whose
  metadata already has `billingTelecomFees` OR whose `taxEnabled` is already
  true. Re-runs are no-ops. Operator-configured billing always wins.

## ⛔ The two traps that would have made E911 $0 anyway

1. **`per_did` counts only BILLABLE numbers.** With the default
   first-number-free, a one-number tenant's billable count is 0 → E911 line
   skipped entirely. New basis **`per_phone_number`** (added to
   `billingTelecomFees.ts`) counts EVERY active number including the free
   first one. Never "fix" the onboarding stamp back to `per_did`.
2. **Onboarding numbers never reach the Connect `phoneNumber` table.** The
   purchased DID only exists as a PBX-synced `PbxTenantInboundDid` row. The
   engine now feeds the basis `max(phoneNumber-table total, active PBX DID
   count)` — max, not sum, so a number present in both sources is charged once.

## Verification

- `apps/api/src/onboarding/onboardingBillingDefaults.test.ts` — month-2
  **preview** (`buildBillingInvoicePreview`, nothing charged) must equal the
  quote to the cent: $35 bare, $45 with SMS, single $3 E911 when the number is
  in both tables, guard behavior. Runs in the standard api test glob.
  Test-harness gotcha: ONE shared `mock.module("@connect/db")` + mutable state
  for the whole file — ESM caches `invoiceEngine` against the first mock, so
  per-test `mock.module` calls silently test a stale binding.
- Also fixed pre-existing breakage: `invoiceEngine.test.ts` mocks lacked
  `tenantPbxLink` / `pbxTenantInboundDid`, so every preview test in that file
  had been throwing since the PBX-DID lines were added to the engine.
- Backfill for sign-ups paid before the fix:
  `pnpm exec tsx scripts/backfill-onboarding-telecom-fees.ts` from `apps/api`
  (dry-run default, `--fix` applies; prints each tenant's next-month preview
  next to its quote). At deploy time there were **zero** paid submissions with
  tenants — nothing needed backfilling.

## Deploy discipline lesson

My worktree was based on origin/main's tip, which carries the UNMERGED
supermarket-delivery work **including a core DB migration**. Production runs
`feat/ai-agent`, which does NOT have it. The fix was cherry-picked onto the
exact production tip (`29fa1af3` → `aafcc2f7`) and tests re-run on that base
before pushing — deploying the worktree branch would have shipped someone
else's migration as a side effect. Check `deployed_commit` in the queue's job
JSON against what you intended.

## Open items / interplay

- The unmerged toll-free/vanity feature (`73f990a0`, another session) plans to
  put its $15/mo recurring charge in the `customFee` slot of the SAME
  `billingTelecomFees` object. My stamp doesn't touch `customFee`, but its
  guard skips tenants where `billingTelecomFees` already exists — so the
  toll-free code must MERGE into the existing config (edit the object), not
  call the stamp again and assume it writes.
- Sales-tax-on-top for future non-onboarding pricing tiers: the stamp encodes
  Izzy's "tax included" promise; don't reuse it for tenants quoted pre-tax.
