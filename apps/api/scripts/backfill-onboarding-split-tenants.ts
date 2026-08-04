/**
 * Repair sign-ups that got split across TWO tenants by the onboarding wizard
 * (fixed in setupOrchestrator.ensureConnectTenant — this cleans up the ones
 * that already happened, e.g. the "Loopcom Pay Test" run on 2026-08-04).
 *
 * What "split" means: checkout created a tenant and attached the first invoice,
 * the vaulted card, and autopay to it — then the PBX build created a SECOND
 * tenant and overwrote submission.createdTenantId. The live phone system is on
 * the second tenant; the money is on the first, so month-2 autopay would never
 * charge the customer.
 *
 * Detection: invoices with metadata.source = "onboarding_signup" whose
 * tenantId ≠ their submission's createdTenantId.
 *
 * Repair (per split, via the same adoptOnboardingBilling the orchestrator now
 * uses): move invoice + line items + transactions + card(s) to the live
 * tenant, carry autopay/default-card/billing-email across, switch the orphan's
 * autopay off, then delete the orphan tenant if (and only if) it is provably
 * empty.
 *
 * Usage (from apps/api, same env as the API — DATABASE_URL etc.):
 *   # Diagnostic only, no writes:
 *   pnpm exec tsx scripts/backfill-onboarding-split-tenants.ts
 *
 *   # Apply the repair:
 *   pnpm exec tsx scripts/backfill-onboarding-split-tenants.ts --fix
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnv(): void {
  const dir = resolve(process.cwd());
  for (const p of [resolve(dir, ".env"), resolve(dir, "../.env")]) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
      break;
    }
  }
}
loadEnv();

async function main() {
  const { db } = await import("@connect/db");
  const { adoptOnboardingBilling, deleteTenantIfEmpty } = await import("../src/onboarding/onboardingBillingAdoption");
  const fix = process.argv.slice(2).includes("--fix");
  console.log(fix ? "MODE: --fix (writing)" : "MODE: dry run (pass --fix to apply)");

  const invoices = await (db as any).billingInvoice.findMany({
    where: { metadata: { path: ["source"], equals: "onboarding_signup" } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Found ${invoices.length} onboarding sign-up invoice(s).`);

  let splits = 0;
  for (const inv of invoices) {
    const submissionId = String((inv.metadata as any)?.onboardingSubmissionId ?? "");
    if (!submissionId) {
      console.log(`- invoice ${inv.invoiceNumber}: no onboardingSubmissionId in metadata — skipping`);
      continue;
    }
    const sub = await (db as any).onboardingSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, companyName: true, createdTenantId: true, pbxSetupStatus: true },
    });
    if (!sub) {
      console.log(`- invoice ${inv.invoiceNumber}: submission ${submissionId} not found — skipping`);
      continue;
    }
    if (!sub.createdTenantId || sub.createdTenantId === inv.tenantId) continue; // not split

    splits++;
    const orphanId = String(inv.tenantId);
    const liveId = String(sub.createdTenantId);
    console.log(`\nSPLIT: "${sub.companyName}" (submission ${sub.id}, build status ${sub.pbxSetupStatus})`);
    console.log(`  invoice ${inv.invoiceNumber} + billing on tenant ${orphanId}`);
    console.log(`  live phone system on tenant       ${liveId}`);

    const live = await (db as any).tenant.findUnique({ where: { id: liveId }, select: { id: true, name: true } });
    if (!live) {
      console.log(`  !! live tenant ${liveId} does not exist — MANUAL REVIEW, skipping`);
      continue;
    }
    // The checkout tenant must actually be a bare orphan. Users, extensions,
    // or a PBX link mean somebody is using it — never rip billing out from
    // under a working tenant automatically.
    const [users, extensions, link] = await Promise.all([
      (db as any).user.count({ where: { tenantId: orphanId } }),
      (db as any).extension.count({ where: { tenantId: orphanId } }),
      (db as any).tenantPbxLink.findFirst({ where: { tenantId: orphanId } }),
    ]);
    if (users > 0 || extensions > 0 || link) {
      console.log(`  !! tenant ${orphanId} is NOT a bare checkout orphan (${users} user(s), ${extensions} extension(s), ${link ? "has" : "no"} PBX link) — MANUAL REVIEW, skipping`);
      continue;
    }

    if (!fix) {
      console.log(`  would move billing ${orphanId} → ${liveId}, then delete ${orphanId} if empty`);
      continue;
    }

    const moved = await adoptOnboardingBilling(db as any, orphanId, liveId);
    console.log(
      `  moved: ${moved.invoicesMoved} invoice(s), ${moved.lineItemsMoved} line item(s), ` +
        `${moved.transactionsMoved} transaction(s), ${moved.paymentMethodsMoved} card(s)` +
        `${moved.autoBillingCarried ? ", autopay ON carried" : ""}` +
        `${moved.defaultPaymentMethodCarried ? `, default card ${moved.defaultPaymentMethodCarried}` : ""}`,
    );
    const cleanup = await deleteTenantIfEmpty(db as any, orphanId);
    console.log(cleanup.deleted ? `  orphan tenant ${orphanId} deleted` : `  orphan tenant ${orphanId} kept (${cleanup.reason})`);
  }

  console.log(`\n${splits} split sign-up(s) found.${fix ? "" : " Re-run with --fix to repair."}`);
  await (db as any).$disconnect?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
