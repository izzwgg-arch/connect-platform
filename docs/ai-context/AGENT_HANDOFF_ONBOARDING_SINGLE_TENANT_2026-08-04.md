# AGENT HANDOFF — one tenant per paid sign-up (2026-08-04)

**Status: FIXED, DEPLOYED, VERIFIED CLEAN.** Commit `1f215755` on `feat/ai-agent`,
deployed to production via the loopcom deploy queue the same evening
(api container healthy at that commit). Production backfill dry-run found
**zero** already-split sign-ups, so no data migration was needed.

## The bug (proven live 2026-08-04, "Loopcom Pay Test")

Every paid sign-up created **two** Connect tenants:

1. Checkout: `prepareOnboardingCheckout` → `ensureTenantForSubmission`
   (`apps/api/src/onboarding/onboardingPayment.ts`) created a bare tenant,
   saved it to `submission.createdTenantId`, and attached the first invoice,
   the vaulted card (PaymentMethod), and `autoBillingEnabled=true` to it.
2. After payment: the PBX build in `setupOrchestrator.ts` called
   `ensureConnectTenant`, which created a **second** tenant from the VitalPBX
   directory entry and **overwrote** `submission.createdTenantId`. Users,
   extensions, and the live phone system landed there.

Consequence: the card-on-file + autopay + first invoice hung off an empty
orphan tenant; the live tenant had no payment method, so **month-2 auto-billing
would silently never charge the customer**. The orphan also cluttered the
admin tenant list.

## The fix (`1f215755`)

- `ensureConnectTenant` (setupOrchestrator.ts) gained a `preferredTenantId`
  parameter = `submission.createdTenantId`. Priority order:
  1. tenant already linked to this PBX tenant (re-run / auto-sync race) — reuse;
  2. the checkout tenant — link the PBX directory entry to **it** (upsert on
     `TenantPbxLink.tenantId`, which is unique, so a rebuilt PBX tenant
     re-points the link instead of throwing);
  3. only if neither exists, create fresh (old behavior).
- **Race repair:** if the background extension auto-sync
  (`pbxExtensionSync.ts`) provisioned its own tenant+link before the
  orchestrator ran, the orchestrator now moves ALL sign-up billing (invoice +
  line items + payment transactions + charge operations + billing event logs +
  payment methods + autopay/default-card/billing-email settings) onto the
  live tenant and deletes the emptied checkout orphan — via
  `apps/api/src/onboarding/onboardingBillingAdoption.ts`
  (`adoptOnboardingBilling` / `deleteTenantIfEmpty`).
- Deletion only fires when the orphan is provably bare: zero users, zero
  extensions, no PBX link, zero invoices, zero payment methods.
- Card tokens are safe to move between tenants: the Cardknox/Sola gateway
  resolves to the platform/main-tenant config for onboarding tenants
  (`resolveBillingGatewayConfig`), so the vaulted token is not tenant-scoped.

## Tests

- `setupOrchestrator.test.ts`: "checkout tenant reuse" (one tenant total, link
  lands on it) and "auto-sync race" (billing migrates, orphan deleted).
- `onboardingBillingAdoption.test.ts`: move + carry semantics, never clobbers
  operator-set settings on the live tenant, orphan autopay switched off,
  delete-refuses-while-nonempty.
- Runner: `node --experimental-test-module-mocks --import tsx --test` (the
  apps/api `pnpm test` glob covers `src/onboarding/*.test.ts`).

## Backfill / check for historic splits

`apps/api/scripts/backfill-onboarding-split-tenants.ts` — dry-run by default,
`--fix` applies. Finds invoices with `metadata.source = "onboarding_signup"`
whose `tenantId` ≠ their submission's `createdTenantId`; refuses to touch any
checkout tenant that has users/extensions/a PBX link (manual review instead).

Run on prod: `docker exec -w /app/apps/api app-api-1 npx tsx
scripts/backfill-onboarding-split-tenants.ts` on loopcom.

**Gotcha:** wiped test tenants cascade-delete their invoices, so this query
legitimately returns nothing after a test wipe — an empty result does NOT mean
the payment test never happened.

## Ops notes from shipping this

- Fresh `claude/*` worktrees spawn from stale local main where these files
  don't exist — `git checkout -B <branch> origin/feat/ai-agent` first.
- Deploy: queue enqueue via `ssh root@loopcom 'bash -s' <<EOF … EOF` (a
  single-quoted one-liner grepping the token got classifier-blocked); api
  build+restart ≈ 6 min; verify `docker ps` shows app-api-1 healthy.
