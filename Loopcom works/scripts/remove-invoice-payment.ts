/**
 * Remove a payment from an invoice and recalculate balances.
 *
 * Usage:
 *   npx tsx scripts/remove-invoice-payment.ts INV-000489 --amount 900
 *   npx tsx scripts/remove-invoice-payment.ts INV-000489 --payment-id <cuid>
 */
/* eslint-disable no-console */

import { prisma } from '../lib/prisma'
import { removeInvoicePayment } from '../lib/payments/remove-invoice-payment'

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return null
  return String(process.argv[idx + 1] || '').trim() || null
}

async function main() {
  const invoiceNumber = process.argv.find(
    (a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]
  )
  const paymentIdArg = argValue('--payment-id')
  const amountArg = argValue('--amount')
  const dryRun = process.argv.includes('--dry-run')

  if (!invoiceNumber) {
    console.error(
      'Usage: npx tsx scripts/remove-invoice-payment.ts <invoiceNumber> [--amount 900] [--payment-id <id>] [--dry-run]'
    )
    process.exit(2)
  }

  const invoice = await prisma.invoice.findFirst({
    where: { invoiceNumber: String(invoiceNumber) },
    select: {
      id: true,
      tenantId: true,
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      balance: true,
      status: true,
      payments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          amount: true,
          method: true,
          status: true,
          reference: true,
          provider: true,
          processedAt: true,
          refunds: { select: { id: true }, take: 1 },
        },
      },
    },
  })

  if (!invoice) {
    console.error('Invoice not found:', invoiceNumber)
    process.exit(1)
  }

  console.log('\n=== Invoice ===')
  console.log({
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    total: Number(invoice.total),
    paidAmount: Number(invoice.paidAmount),
    balance: Number(invoice.balance),
  })

  console.log('\n=== Payments ===')
  for (const p of invoice.payments) {
    console.log({
      id: p.id,
      amount: Number(p.amount),
      method: p.method,
      status: p.status,
      reference: p.reference,
      provider: p.provider,
      processedAt: p.processedAt,
      hasRefunds: p.refunds.length > 0,
    })
  }

  let paymentId = paymentIdArg
  if (!paymentId) {
    const targetAmount = amountArg ? Number(amountArg) : null
    const matches = invoice.payments.filter((p) => {
      if (p.refunds.length > 0) return false
      if (targetAmount != null && Number.isFinite(targetAmount)) {
        return Math.abs(Number(p.amount) - targetAmount) < 0.01
      }
      return true
    })

    if (matches.length === 0) {
      console.error('No matching payment found.')
      process.exit(1)
    }
    if (matches.length > 1 && targetAmount == null) {
      console.error('Multiple payments match — pass --payment-id or --amount.')
      process.exit(1)
    }
    paymentId = matches[0].id
  }

  console.log('\n=== Target payment ===', paymentId)

  if (dryRun) {
    console.log('Dry run — no changes made.')
    return
  }

  const result = await removeInvoicePayment(paymentId, invoice.tenantId)
  console.log('\n=== Result ===')
  console.log(result)

  if (!result.removed) {
    process.exit(1)
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
