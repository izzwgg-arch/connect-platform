/**
 * Standalone runner for the QB balance sync logic.
 * Fetches the real QB balance for every open TrimPro invoice and reconciles discrepancies.
 */
const { PrismaClient } = require('@prisma/client');

// ── Load env ──────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const envFile = path.resolve(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}

const prisma = new PrismaClient();

async function getSession(tenantId) {
  const integration = await prisma.quickBooksIntegration.findUnique({ where: { tenantId } });
  if (!integration || !integration.isConnected) return null;
  return {
    accessToken: integration.accessToken,
    refreshToken: integration.refreshToken,
    realmId: integration.realmId,
  };
}

async function qboGet(accessToken, realmId, path) {
  const base = process.env.QBO_BASE_URL || 'https://quickbooks.api.intuit.com';
  const url = `${base}/v3/company/${realmId}${path}?minorversion=65`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`QB API ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function toMoney(n) { return Math.round(n * 100) / 100; }

async function main() {
  // Find tenant with QB integration
  const integration = await prisma.quickBooksIntegration.findFirst({
    where: { isConnected: true },
    select: { tenantId: true, accessToken: true, realmId: true },
  });
  if (!integration) { console.error('No connected QB integration found'); process.exit(1); }

  const { tenantId, accessToken, realmId } = integration;
  console.log('Tenant:', tenantId);
  console.log('Realm:', realmId);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      qboSyncId: { not: null },
      balance: { gt: 0 },
      status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] },
    },
    select: { id: true, qboSyncId: true, balance: true, total: true, paidAmount: true, status: true, invoiceNumber: true },
    orderBy: { balance: 'desc' },
  });

  console.log(`\nChecking ${invoices.length} open invoices against QuickBooks…\n`);

  let synced = 0, skipped = 0, errors = 0;
  const changes = [];

  for (const invoice of invoices) {
    try {
      const data = await qboGet(accessToken, realmId, `/invoice/${invoice.qboSyncId}`);
      const qboInv = data?.Invoice;
      if (!qboInv) { console.log(`  [SKIP] #${invoice.invoiceNumber} — not found in QB`); skipped++; continue; }

      const qboBalance = Number(qboInv.Balance ?? qboInv.BalanceAmt ?? NaN);
      if (!Number.isFinite(qboBalance)) { skipped++; continue; }

      const localBalance = Number(invoice.balance);
      const delta = toMoney(localBalance - qboBalance);

      if (delta <= 0) {
        // QB balance matches or is higher — no action needed
        skipped++;
        continue;
      }

      console.log(`  [SYNC] #${invoice.invoiceNumber}  local=$${localBalance.toFixed(2)}  QB=$${qboBalance.toFixed(2)}  delta=$${delta.toFixed(2)}`);

      const reference = `qbo_bulksync_${invoice.qboSyncId}_${qboBalance.toFixed(2)}`;
      const existing = await prisma.payment.findFirst({ where: { reference } });
      if (existing) { console.log(`         already reconciled, skipping`); skipped++; continue; }

      const appliedAmount = Math.min(localBalance, delta);

      await prisma.$transaction(async (tx) => {
        const current = await tx.invoice.findUnique({
          where: { id: invoice.id },
          select: { id: true, total: true, paidAmount: true, balance: true, status: true, paidAt: true },
        });
        if (!current || Number(current.balance) <= 0) return;

        await tx.payment.create({
          data: {
            invoiceId: current.id,
            amount: appliedAmount,
            status: 'COMPLETED',
            method: 'OTHER',
            reference,
            provider: 'quickbooks',
            providerPaymentId: reference,
            providerInvoiceId: invoice.qboSyncId,
            providerRealmId: realmId,
            processedAt: new Date(),
            notes: 'QuickBooks balance sync (script)',
          },
        });

        const newPaidAmount = Number(current.paidAmount) + appliedAmount;
        const newBalance = Math.max(0, toMoney(Number(current.total) - newPaidAmount));

        await tx.invoice.update({
          where: { id: current.id },
          data: {
            paidAmount: newPaidAmount,
            balance: newBalance,
            status: newBalance <= 0 ? 'PAID' : newPaidAmount > 0 ? 'PARTIAL' : current.status,
            paidAt: newBalance <= 0 ? new Date() : current.paidAt,
          },
        });
      });

      changes.push({ invoiceNumber: invoice.invoiceNumber, localBalance, qboBalance, applied: appliedAmount });
      synced++;
    } catch (e) {
      if (String(e.message).includes('401') || String(e.message).includes('403')) {
        console.error('\nAccess token expired or invalid. Please reconnect QuickBooks in Settings → Integrations.');
        process.exit(1);
      }
      console.error(`  [ERR] #${invoice.invoiceNumber}: ${e.message}`);
      errors++;
    }
  }

  console.log('\n=== SYNC COMPLETE ===');
  console.log(`Checked:  ${invoices.length}`);
  console.log(`Synced:   ${synced}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Errors:   ${errors}`);

  if (changes.length > 0) {
    console.log('\nChanges made:');
    changes.forEach(c => {
      console.log(`  #${c.invoiceNumber}  was=$${c.localBalance.toFixed(2)}  now_QB=$${c.qboBalance.toFixed(2)}  applied=$${c.applied.toFixed(2)}`);
    });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
