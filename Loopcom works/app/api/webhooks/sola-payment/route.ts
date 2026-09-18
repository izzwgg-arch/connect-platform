import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { notifyInvoicePaid } from '@/lib/notifications'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { orderInvoicesByStoredIds } from '@/lib/payments/bulk-card-allocation'
import { afterInvoicePayment } from '@/lib/payments/after-invoice-payment'
import { applyInvoicePayment } from '@/lib/payments/apply-payment'
import { sendPaymentReceiptForPayment } from '@/lib/payments/receipts'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    let body: Record<string, any> = {}
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      // Cardknox commonly posts x-www-form-urlencoded (xResult=...&xInvoice=...)
      const params = new URLSearchParams(rawBody)
      body = Object.fromEntries(params.entries())
    }

    const resultCode = String(body?.Result || body?.result || body?.xResult || '')
    const paymentStatus = String(body?.status || '').toLowerCase()
    const normalizedResult = resultCode.toUpperCase()
    const isSuccess =
      normalizedResult === 'S' ||
      normalizedResult === 'A' ||
      normalizedResult === 'APPROVED' ||
      paymentStatus === 'completed' ||
      paymentStatus === 'paid' ||
      paymentStatus === 'approved'
    if (!isSuccess) {
      return NextResponse.json({ ok: true, ignored: true })
    }

    // xCustom1 carries the intent key when xInvoice is set to human-readable invoice numbers
    const intentRefRaw = String(body?.xCustom1 || body?.xCustom || '')
    const invoiceRefRaw = String(body?.invoiceId || body?.xInvoice || body?.InvoiceID || '')
    // Prefer the explicit intent ref; fall back to xInvoice if it contains the TPINTENT prefix
    let invoiceRef = intentRefRaw.startsWith('TPINTENT:')
      ? intentRefRaw
      : invoiceRefRaw.startsWith('TPINTENT:')
        ? invoiceRefRaw
        : invoiceRefRaw

    // Cardknox sometimes omits xCustom1 on return/webhook while xInvoice lists multiple numbers.
    if (!invoiceRef.startsWith('TPINTENT:') && invoiceRef.includes(',')) {
      const invoiceNumbers = invoiceRef
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      if (invoiceNumbers.length > 1) {
        const recentIntents = await prisma.idempotencyKey.findMany({
          where: {
            scope: 'public_payment_intent',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: { key: true, response: true },
        })
        for (const row of recentIntents) {
          const resp = (row.response || {}) as any
          const nums = Array.isArray(resp?.invoiceNumbers)
            ? resp.invoiceNumbers.map((n: any) => String(n || '').trim()).filter(Boolean)
            : []
          if (!nums.length) continue
          const matches =
            invoiceNumbers.length === nums.length &&
            invoiceNumbers.every((num) => nums.includes(num))
          if (matches) {
            invoiceRef = `TPINTENT:${row.key}`
            break
          }
        }
      }
    }

    if (!invoiceRef) {
      return NextResponse.json({ error: 'Missing invoice reference' }, { status: 400 })
    }

    const paidAmount = Number(body?.amount || body?.xAmount || 0)
    const transactionId = String(
      body?.transactionId || body?.TransactionID || body?.xRefNum || body?.xRefnum || ''
    )

    // ------------------------------------------------------------------
    // Idempotency guard (per gateway transaction).
    //
    // A single successful charge is delivered to us MORE THAN ONCE: Cardknox
    // posts a server-side webhook AND the customer's browser posts a "return"
    // confirmation to this same endpoint. Those deliveries can land in different
    // branches (single vs. distributed/TPINTENT) and historically used
    // non-colliding ids, which is how one $5,000 payment produced a second
    // phantom full-balance payment. Once ANY payment row exists for this
    // transaction (single "txn" or distributed "txn:invoiceId"), every later
    // delivery is a no-op.
    // ------------------------------------------------------------------
    if (transactionId) {
      const alreadyProcessed = await prisma.payment.findFirst({
        where: {
          OR: [
            { solaTransactionId: transactionId },
            { solaTransactionId: { startsWith: `${transactionId}:` } },
            { provider: 'sola', providerPaymentId: transactionId },
            { provider: 'sola', providerPaymentId: { startsWith: `${transactionId}:` } },
          ],
        },
        select: { id: true },
      })
      if (alreadyProcessed) {
        return NextResponse.json({ ok: true, deduped: true })
      }
    }

    // Bulk payment reference format: "TPINTENT:<intentKey>"
    if (invoiceRef.startsWith('TPINTENT:')) {
      const intentKey = invoiceRef.slice('TPINTENT:'.length).trim()
      if (!intentKey) return NextResponse.json({ error: 'Missing intent reference' }, { status: 400 })

      const intent = await prisma.idempotencyKey.findUnique({
        where: { key: intentKey },
        select: { tenantId: true, response: true, expiresAt: true },
      })
      if (!intent) return NextResponse.json({ error: 'Payment intent not found' }, { status: 404 })
      if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
        return NextResponse.json({ error: 'Payment intent expired' }, { status: 400 })
      }

      const resp = (intent.response || {}) as any
      const clientId = String(resp?.clientId || '').trim()
      const invoiceIds = Array.isArray(resp?.invoiceIds) ? resp.invoiceIds.map((x: any) => String(x || '').trim()).filter(Boolean) : []
      const plannedAmountsByInvoice =
        resp?.plannedAmountsByInvoice && typeof resp.plannedAmountsByInvoice === 'object'
          ? (resp.plannedAmountsByInvoice as Record<string, any>)
          : null
      const allocationMode = typeof resp?.allocationMode === 'string' ? String(resp.allocationMode) : null
      const maxTotalAmount = resp?.maxTotalAmount != null ? Number(resp.maxTotalAmount) : null
      if (!clientId || !invoiceIds.length) {
        return NextResponse.json({ error: 'Invalid payment intent' }, { status: 400 })
      }

      const client = await prisma.client.findFirst({
        where: { id: clientId },
        include: {
          contacts: {
            where: { isPrimary: true },
            take: 1,
          },
        },
      })
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

      const openInvoices = orderInvoicesByStoredIds(
        invoiceIds,
        await prisma.invoice.findMany({
          where: {
            tenantId: intent.tenantId,
            clientId: client.id,
            id: { in: invoiceIds },
            balance: { gt: 0 } as any,
            status: { notIn: ['PAID', 'CANCELLED', 'REFUNDED'] as any },
          },
        })
      )

      const totalOutstanding = openInvoices.reduce((sum, inv) => sum + Math.max(0, Number(inv.balance || 0)), 0)
      const plannedTotal = plannedAmountsByInvoice
        ? openInvoices.reduce((sum, inv) => sum + Math.max(0, Number(plannedAmountsByInvoice[String(inv.id)] || 0)), 0)
        : 0
      let remaining = paidAmount > 0 ? paidAmount : totalOutstanding
      if (plannedAmountsByInvoice && plannedTotal > 0) {
        remaining = Math.min(remaining, plannedTotal)
      }
      if (allocationMode === 'waterfall' && maxTotalAmount != null && Number.isFinite(maxTotalAmount) && maxTotalAmount > 0) {
        remaining = Math.min(remaining, maxTotalAmount)
      }
      let appliedCount = 0
      let appliedTotal = 0
      // One customer card charge -> one payment group, even across many invoices.
      // This lets the QuickBooks sync record it as a SINGLE payment distributed
      // across the invoices instead of many separate payments.
      const paymentGroupId = `pg_${transactionId || crypto.randomBytes(12).toString('hex')}`
      const groupedPaymentIds: string[] = []

      for (const inv of openInvoices) {
        if (remaining <= 0) break
        const invBalance = Math.max(0, Number(inv.balance || 0))
        if (invBalance <= 0) continue
        const plannedForThis = plannedAmountsByInvoice ? Number(plannedAmountsByInvoice[String(inv.id)] || 0) : 0
        const maxForThis =
          plannedAmountsByInvoice && plannedForThis > 0
            ? Math.min(invBalance, plannedForThis)
            : invBalance
        const amountForThis = Math.min(remaining, maxForThis)
        if (amountForThis <= 0) continue

        const uniqueTxn = transactionId ? `${transactionId}:${inv.id}` : `BULK:${Date.now()}:${inv.id}`
        const invoiceRef = inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : `Invoice ${inv.id}`
        const cleanTxnId = transactionId ? String(transactionId).trim() : ''

        const result = await applyInvoicePayment({
          invoiceId: inv.id,
          amount: amountForThis,
          method: 'CARD',
          provider: 'sola',
          // Unique per invoice — same card txn pays multiple invoices.
          providerPaymentId: uniqueTxn || null,
          reference: cleanTxnId ? `${cleanTxnId} - ${invoiceRef}` : invoiceRef,
          solaTransactionId: uniqueTxn,
          solaWebhookData: body,
          processedAt: new Date(),
          notes: `Bulk payment for ${invoiceRef}`,
          paymentGroupId,
          dedupeWhere: { solaTransactionId: uniqueTxn },
        })
        if (!result.created || !result.paymentId) continue
        groupedPaymentIds.push(result.paymentId)

        const appliedThis = result.invoice
          ? Math.max(0, Number(result.invoice.paidAmount) - (Number(inv.paidAmount || 0)))
          : amountForThis

        try {
          await afterInvoicePayment(inv.id)
        } catch (error) {
          console.error('[sola-payment] afterInvoicePayment failed (bulk):', {
            invoiceId: inv.id,
            error,
          })
        }

        appliedCount += 1
        appliedTotal += appliedThis
        remaining -= appliedThis
      }

      // Sync the whole group to QuickBooks as ONE payment (multiple invoice lines).
      if (groupedPaymentIds.length > 0) {
        try {
          await enqueueQboSync(client.tenantId, 'payment', groupedPaymentIds[0], { processImmediately: true })
        } catch (error) {
          console.error('QuickBooks payment sync trigger error (bulk group):', error)
        }
      }

      // Notify office/admin/accounting once (avoid spamming N notifications)
      try {
        const firstInvoice = openInvoices[0]
        if (firstInvoice && appliedCount > 0) {
          await notifyInvoicePaid(
            client.tenantId,
            firstInvoice.id,
            appliedCount > 1 ? `${firstInvoice.invoiceNumber} (+${appliedCount - 1} more)` : firstInvoice.invoiceNumber,
            appliedTotal,
            client.name || 'Customer',
            {
              paymentMethod: 'CARD',
              providerPaymentId: transactionId || null,
              dedupeKey: `payment-received-bulk:${client.tenantId}:${transactionId || 'bulk'}`,
            }
          )
        }
      } catch {
        // ignore
      }

      // One receipt email + PDF per invoice payment applied.
      for (const paymentId of groupedPaymentIds) {
        try {
          await sendPaymentReceiptForPayment(paymentId, client.tenantId)
        } catch (error) {
          console.error('Bulk receipt email error:', error)
        }
      }

      return NextResponse.json({ ok: true, bulk: true, appliedCount, appliedTotal })
    }

    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [{ id: invoiceRef }, { invoiceNumber: invoiceRef }],
      },
      include: {
        client: {
          include: {
            contacts: {
              where: { isPrimary: true },
              take: 1,
            },
          },
        },
        estimate: {
          include: {
            lead: true,
          },
        },
      job: {
        select: { id: true, jobNumber: true, title: true },
      },
    },
  })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Only ever record the amount the gateway actually reported. A success
    // confirmation with no amount (which the browser "return" callback can
    // produce) must NEVER move money — inventing the full balance here is what
    // recorded a phantom full-balance payment and flipped deposits to PAID. The
    // authoritative gateway webhook always carries the amount, so we safely
    // record nothing and let that delivery (or QBO reconcile) apply it.
    if (!(paidAmount > 0)) {
      return NextResponse.json({ ok: true, ignored: 'missing_amount' })
    }
    const requestedAmount = paidAmount

    const result = await applyInvoicePayment({
      invoiceId: invoice.id,
      amount: requestedAmount,
      method: 'CARD',
      provider: 'sola',
      providerPaymentId: String(transactionId || ''),
      providerInvoiceId: String(invoiceRef || invoice.invoiceNumber || ''),
      reference: transactionId || null,
      solaTransactionId: transactionId || null,
      solaWebhookData: body,
      processedAt: new Date(),
      dedupeWhere: transactionId ? { solaTransactionId: transactionId } : undefined,
    })

    const amount = result.invoice
      ? Math.max(0, Number(result.invoice.paidAmount) - Number(invoice.paidAmount))
      : 0

    if (result.created && result.paymentId) {
      if (transactionId) {
        await prisma.invoice
          .update({ where: { id: invoice.id }, data: { solaTransactionId: transactionId } })
          .catch(() => undefined)
      }

      try {
        await enqueueQboSync(invoice.tenantId, 'payment', result.paymentId, { processImmediately: true })
      } catch (error) {
        console.error('QuickBooks payment sync trigger error:', error)
      }

      if (amount > 0) {
        try {
          await sendPaymentReceiptForPayment(result.paymentId, invoice.tenantId)
        } catch (error) {
          console.error('Failed to send payment receipt email:', error)
        }
      }

      await notifyInvoicePaid(
        invoice.tenantId,
        invoice.id,
        invoice.invoiceNumber,
        amount,
        invoice.client.name,
        {
          paymentMethod: 'CARD',
          providerPaymentId: transactionId || null,
          dedupeKey: `payment-received:${invoice.tenantId}:${invoice.id}:${transactionId || invoice.id}`,
        }
      )

      await afterInvoicePayment(invoice.id)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Sola payment webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

