/**
 * Stamp telecom-fee billing defaults onto tenants that onboarding created
 * BEFORE the stamp shipped (added 2026-08-04, deadline: the Sept 1 billing
 * run). Without it their month-2 automatic invoice is bare $30/extension —
 * no E911, no $2 telecom fee — breaking the "$35 a month, including tax"
 * promise from checkout and the report email.
 *
 * Targets: onboardingSubmission rows with a createdTenantId AND paidAt set
 * (only the new pay-at-checkout flow stamps paidAt, so this can never touch
 * pre-existing tenants). The stamp itself additionally refuses any tenant
 * that already has a fee config or taxEnabled.
 *
 * Usage (from apps/api, same env as the API — DATABASE_URL etc.):
 *   # Diagnostic only, no writes — also prints each tenant's next-month preview:
 *   pnpm exec tsx scripts/backfill-onboarding-telecom-fees.ts
 *
 *   # Apply:
 *   pnpm exec tsx scripts/backfill-onboarding-telecom-fees.ts --fix
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

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  const { db } = await import("@connect/db");
  const { ensureOnboardingBillingDefaults } = await import("../src/onboarding/onboardingBillingDefaults");
  const { buildBillingInvoicePreview } = await import("../src/billing/invoiceEngine");
  const { quoteForSubmission } = await import("../src/onboarding/onboardingPayment");
  const fix = process.argv.slice(2).includes("--fix");
  console.log(fix ? "MODE: --fix (writing)" : "MODE: dry run (pass --fix to apply)");

  const subs = await (db as any).onboardingSubmission.findMany({
    where: { createdTenantId: { not: null }, paidAt: { not: null } },
    include: { requestedExtensions: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Found ${subs.length} paid onboarding submission(s) with a tenant.`);

  let stamped = 0;
  for (const sub of subs) {
    const tenantId = String(sub.createdTenantId);
    const quote = quoteForSubmission(sub);
    console.log(`\n"${sub.companyName}" (submission ${sub.id}, paid ${new Date(sub.paidAt).toISOString().slice(0, 10)})`);
    console.log(`  tenant ${tenantId} — quoted ${fmt(quote.monthlyTotalCents)}/month`);

    const tenant = await (db as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) {
      console.log("  !! tenant no longer exists — skipping");
      continue;
    }

    if (!fix) {
      const settings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
      const hasFees = !!(settings?.metadata as any)?.billingTelecomFees;
      if (hasFees) {
        console.log("  fee config already present — nothing to do");
      } else if (settings?.taxEnabled) {
        console.log("  taxes already enabled (operator-configured) — would skip");
      } else {
        console.log(`  would stamp E911 + telecom fees${sub.smsEnabled ? " (+ SMS billing on)" : ""}`);
      }
    } else {
      const result = await ensureOnboardingBillingDefaults(db as any, tenantId, { smsEnabled: !!sub.smsEnabled });
      console.log(`  ${result.stamped ? "STAMPED" : `skipped: ${result.reason}`}`);
      if (result.stamped) stamped++;
    }

    // Preview what next month's automatic invoice would total right now.
    try {
      const preview = await buildBillingInvoicePreview({ tenantId });
      const match = preview.totalCents === quote.monthlyTotalCents ? "MATCHES quote" : `quote says ${fmt(quote.monthlyTotalCents)} — MISMATCH`;
      console.log(`  next-month preview: ${fmt(preview.totalCents)} (${match})`);
    } catch (e: any) {
      console.log(`  next-month preview failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  console.log(`\n${fix ? `${stamped} tenant(s) stamped.` : "Dry run complete — re-run with --fix to apply."}`);
  await (db as any).$disconnect?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
