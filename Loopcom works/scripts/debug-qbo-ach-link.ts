/**
 * Debug helper (server-side): inspect why QBO isn't returning InvoiceLink for ACH hosted payments.
 *
 * Usage on server:
 *   npx tsx scripts/debug-qbo-ach-link.ts <invoiceId>
 */
/* eslint-disable no-console */

import { prisma } from '../lib/prisma'
import { getQboSessionForTenant } from '../lib/qbo/session'
import { quickBooksService } from '../lib/services/quickbooks'
import { createAchPaymentSession } from '../lib/qbo/payments-ach'

async function main() {
  const invoiceId = process.argv[2]
  const shouldCreate = process.argv.includes('--create')
  if (!invoiceId) {
    console.error('Usage: npx tsx scripts/debug-qbo-ach-link.ts <invoiceId> [--create]')
    process.exit(2)
  }

  const inv = await prisma.invoice.findUnique({
    where: { id: String(invoiceId) },
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      invoiceNumber: true,
      qboSyncId: true,
      qboAchEnabled: true,
      balance: true,
      createdAt: true,
      client: { select: { email: true, name: true, companyName: true } },
    },
  })
  console.log('Local invoice:', inv)

  if (!inv?.tenantId) {
    console.error('Invoice not found')
    process.exit(1)
  }

  const session = await getQboSessionForTenant(inv.tenantId)
  console.log('Has QBO session:', Boolean(session), session ? { realmId: session.realmId } : null)
  if (!session) process.exit(1)

  if (!inv.qboSyncId) {
    console.error('Invoice has no qboSyncId')
    process.exit(1)
  }

  if (shouldCreate) {
    try {
      const result = await createAchPaymentSession({
        tenantId: inv.tenantId,
        invoiceId: inv.id,
        createdById: null,
      })
      console.log('createAchPaymentSession result:', result)
    } catch (e) {
      console.error('createAchPaymentSession error:', e instanceof Error ? e.message : e)
    }
  }

  const res = await quickBooksService.makeAPIRequest(session.accessToken, session.realmId, `/invoice/${inv.qboSyncId}`, 'GET')
  const qboInv: any = res?.Invoice || res?.QueryResponse?.Invoice?.[0] || null

  const link = qboInv?.InvoiceLink || qboInv?.InvoiceLinkUri || qboInv?.OnlineInvoiceLink || qboInv?.OnlineInvoiceUrl || null

  console.log('QBO Id/SyncToken:', { Id: qboInv?.Id, SyncToken: qboInv?.SyncToken })
  console.log('QBO InvoiceLink-ish:', link)
  console.log('QBO AllowOnline flags:', {
    AllowOnlinePayment: qboInv?.AllowOnlinePayment,
    AllowOnlineACHPayment: qboInv?.AllowOnlineACHPayment,
    AllowOnlineCreditCardPayment: qboInv?.AllowOnlineCreditCardPayment,
  })
  console.log('QBO EmailStatus:', qboInv?.EmailStatus)
  console.log('QBO BillEmail:', qboInv?.BillEmail)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

