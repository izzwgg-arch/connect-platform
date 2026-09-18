/**
 * Debug helper (server-side): inspect why QBO isn't returning InvoiceLink for ACH hosted payments.
 *
 * Usage on server:
 *   node scripts/debug-qbo-ach-link.js <invoiceId>
 */

/* eslint-disable no-console */

async function main() {
  const invoiceId = process.argv[2]
  if (!invoiceId) {
    console.error('Usage: node scripts/debug-qbo-ach-link.js <invoiceId>')
    process.exit(2)
  }

  const { prisma } = require('../lib/prisma')
  const { getQboSessionForTenant } = require('../lib/qbo/session')
  const { quickBooksService } = require('../lib/services/quickbooks')

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

  if (!session) {
    console.error('No QBO session for tenant')
    process.exit(1)
  }

  if (!inv.qboSyncId) {
    console.error('Invoice has no qboSyncId')
    process.exit(1)
  }

  const res = await quickBooksService.makeAPIRequest(session.accessToken, session.realmId, `/invoice/${inv.qboSyncId}`, 'GET')
  const qboInv = res?.Invoice || res?.QueryResponse?.Invoice?.[0] || null

  console.log('QBO invoice keys:', qboInv ? Object.keys(qboInv).sort() : null)
  console.log('QBO InvoiceLink-ish:', {
    InvoiceLink: qboInv?.InvoiceLink,
    InvoiceLinkUri: qboInv?.InvoiceLinkUri,
    OnlineInvoiceLink: qboInv?.OnlineInvoiceLink,
    OnlineInvoiceUrl: qboInv?.OnlineInvoiceUrl,
  })
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

