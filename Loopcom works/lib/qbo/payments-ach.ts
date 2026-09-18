import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { quickBooksService } from '@/lib/services/quickbooks'
import { getQboSessionForTenant, assertQuickBooksAchEnabledFlag } from './session'

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomPublicToken(): string {
  // 256-bit token (unguessable)
  return crypto.randomBytes(32).toString('hex')
}

function randomAttemptToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export type AchSessionResult = {
  intentId: string
  publicUrl: string
  hostedUrl: string
  returnToken: string
  returnUrl: string
}

function appBaseUrl(): string {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.CANONICAL_PUBLIC_APP_URL,
    'https://app.trimprony.com',
  ]

  const blocked = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\b\d{1,3}(\.\d{1,3}){3}\b)(:\d+)?/i

  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (!value) continue
    if (blocked.test(value)) continue
    return value.replace(/\/+$/, '').replace(/^http:\/\//i, 'https://')
  }

  return 'https://app.trimprony.com'
}

/**
 * Fetch QBO invoice, enable hosted online ACH if possible, and return the InvoiceLink.
 *
 * Intuit behavior notes:
 * - Online ACH availability depends on QuickBooks Payments being enabled for the company.
 * - If Payments isn't enabled, QBO may ignore AllowOnlineACHPayment or not provide InvoiceLink.
 */
async function ensureQboInvoiceAchHostedLink(params: {
  tenantId: string
  accessToken: string
  realmId: string
  qboInvoiceId: string
  sendToEmail?: string | null
}): Promise<string> {
  const getInvoice = async () => {
    const res = await quickBooksService.makeAPIRequest(
      params.accessToken,
      params.realmId,
      `/invoice/${params.qboInvoiceId}`,
      'GET',
      undefined,
      {
        tenantId: params.tenantId,
        entityType: 'invoice',
        entityId: params.qboInvoiceId,
        triggerSource: 'qbo_ach_hosted_link',
      }
    )
    return res?.Invoice || res?.QueryResponse?.Invoice?.[0] || null
  }

  const extractLink = (inv: any): string | null => {
    const maybeLink = inv?.InvoiceLink || inv?.InvoiceLinkUri || inv?.OnlineInvoiceLink || inv?.OnlineInvoiceUrl
    return maybeLink ? String(maybeLink) : null
  }

  const inv = await getInvoice()
  if (!inv?.Id) {
    throw new Error('QuickBooks invoice not found.')
  }

  const existingLink = extractLink(inv)
  if (inv.AllowOnlineACHPayment && existingLink) {
    return existingLink
  }

  // Update invoice to allow online payments (ACH).
  const payload: any = {
    Id: String(inv.Id),
    SyncToken: String(inv.SyncToken || '0'),
    sparse: true,
    AllowOnlinePayment: true,
    // ACH-only flow: explicitly disable card rails so the hosted page shows bank payment only.
    AllowOnlineCreditCardPayment: false,
    AllowOnlineACHPayment: true,
  }

  // For API-created invoices, QBO often doesn't generate InvoiceLink until the invoice has a BillEmail
  // (and sometimes an EmailStatus). This does not force an email send; it just records where it would send.
  if (params.sendToEmail) {
    payload.BillEmail = { Address: String(params.sendToEmail) }
    payload.EmailStatus = 'NeedToSend'
  }

  await quickBooksService.makeAPIRequest(
    params.accessToken,
    params.realmId,
    `/invoice?operation=update`,
    'POST',
    payload,
    {
      tenantId: params.tenantId,
      entityType: 'invoice',
      entityId: params.qboInvoiceId,
      triggerSource: 'qbo_ach_hosted_link',
    }
  )

  // QBO sometimes generates InvoiceLink asynchronously (especially for freshly-created invoices).
  // Poll up to 3 times (reduced from 5) before attempting the send fallback.
  for (let attempt = 0; attempt < 3; attempt++) {
    const updated = await getInvoice()
    const updatedLink = extractLink(updated)
    if (updatedLink) return updatedLink
    await new Promise((r) => setTimeout(r, 600 + attempt * 400))
  }

  // If ACH works for imported invoices but not for freshly-created ones, QBO often requires the invoice to be "sent"
  // before it produces `InvoiceLink`. We only attempt this if we have an email to send to.
  const sendTo = String(params.sendToEmail || '').trim()
  if (sendTo) {
    try {
      const sendRes = await quickBooksService.makeAPIRequest(
        params.accessToken,
        params.realmId,
        `/invoice/${encodeURIComponent(params.qboInvoiceId)}/send?sendTo=${encodeURIComponent(sendTo)}`,
        'POST',
        {},
        {
          tenantId: params.tenantId,
          entityType: 'invoice',
          entityId: params.qboInvoiceId,
          triggerSource: 'qbo_ach_hosted_link',
        }
      )
      const sentInvoice = sendRes?.Invoice || sendRes?.QueryResponse?.Invoice?.[0] || null
      const sentLink = extractLink(sentInvoice)
      if (sentLink) return sentLink
    } catch (e) {
      // If sending fails, fall back to the generic error below.
    }

    // Poll up to 3 times after the send (reduced from 5).
    for (let attempt = 0; attempt < 3; attempt++) {
      const afterSend = await getInvoice()
      const linkAfterSend = extractLink(afterSend)
      if (linkAfterSend) return linkAfterSend
      await new Promise((r) => setTimeout(r, 700 + attempt * 400))
    }
  }

  throw new Error('QuickBooks did not provide a hosted payment link for this invoice.')
}

export async function createAchPaymentSession(params: {
  tenantId: string
  invoiceId: string
  createdById: string | null
}): Promise<AchSessionResult> {
  assertQuickBooksAchEnabledFlag()

  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, tenantId: params.tenantId },
    include: {
      client: {
        select: {
          email: true,
          contacts: {
            where: { email: { not: null } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            take: 1,
            select: { email: true },
          },
        },
      },
    },
  })
  if (!invoice) throw new Error('Invoice not found.')

  if (!invoice.qboSyncId) {
    throw new Error('Invoice is not synced to QuickBooks yet (missing QuickBooks invoice id).')
  }

  if (Number(invoice.balance) <= 0) {
    throw new Error('Invoice has no balance due.')
  }

  const session = await getQboSessionForTenant(params.tenantId)
  if (!session) {
    throw new Error('QuickBooks is not connected for this company.')
  }

  const sendToEmail =
    String(invoice.client?.email || '').trim() || String(invoice.client?.contacts?.[0]?.email || '').trim() || null
  if (!sendToEmail) {
    // QBO typically requires BillEmail/EmailStatus to generate InvoiceLink for API-created invoices.
    throw new Error('Client email is required to generate a QuickBooks ACH payment link. Please add an email to the client and try again.')
  }

  const amount = invoice.balance
  const currency = 'USD'
  const idempotencyKey = sha256(
    `qbo_ach_session:${params.tenantId}:${invoice.id}:${String(invoice.qboSyncId)}:${String(amount)}:${currency}`
  )

  const existingKey = await prisma.idempotencyKey.findUnique({
    where: { key: idempotencyKey },
  })
  const returnToken = randomAttemptToken()
  const returnTokenExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
  if (existingKey?.response) {
    const resp: any = existingKey.response
    if (resp?.publicUrl && resp?.hostedUrl && resp?.intentId) {
      const updatedIntent = await prisma.invoicePaymentIntent.update({
        where: { id: String(resp.intentId) },
        data: {
          returnToken,
          returnTokenExpiresAt,
        },
        select: { id: true },
      })
      const returnUrl = `${appBaseUrl()}/pay/return?provider=quickbooks&attempt=${encodeURIComponent(returnToken)}&result=success`
      return {
        intentId: updatedIntent.id,
        publicUrl: resp.publicUrl,
        hostedUrl: resp.hostedUrl,
        returnToken,
        returnUrl,
      }
    }
  }

  const hostedUrl = await ensureQboInvoiceAchHostedLink({
    tenantId: params.tenantId,
    accessToken: session.accessToken,
    realmId: session.realmId,
    qboInvoiceId: String(invoice.qboSyncId),
    sendToEmail,
  })

  const publicToken = randomPublicToken()
  const intent = await prisma.invoicePaymentIntent.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: invoice.id,
      provider: 'qbo',
      method: 'ach',
      amount,
      currency,
      status: 'LINK_CREATED',
      qboRealmId: session.realmId,
      qboInvoiceId: String(invoice.qboSyncId),
      hostedUrl,
      publicToken,
      returnToken,
      returnTokenExpiresAt,
      idempotencyKey,
      createdById: params.createdById || null,
      customerEmail: sendToEmail,
      metadata: {
        source: 'invoice_detail',
        invoiceNumber: invoice.invoiceNumber || invoice.id,
        qboInvoiceId: String(invoice.qboSyncId),
      },
    },
  })

  const publicUrl = `${appBaseUrl()}/pay/invoice/${publicToken}`
  const returnUrl = `${appBaseUrl()}/pay/return?provider=quickbooks&attempt=${encodeURIComponent(returnToken)}&result=success`

  await prisma.idempotencyKey.upsert({
    where: { key: idempotencyKey },
    create: {
      tenantId: params.tenantId,
      key: idempotencyKey,
      scope: 'qbo_ach_create_session',
      requestHash: idempotencyKey,
      response: { intentId: intent.id, publicUrl, hostedUrl },
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
    },
    update: {
      response: { intentId: intent.id, publicUrl, hostedUrl },
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  })

  await prisma.paymentEvent.create({
    data: {
      tenantId: params.tenantId,
      intentId: intent.id,
      provider: 'qbo',
      type: 'create_session',
      statusFrom: 'CREATED',
      statusTo: 'LINK_CREATED',
      payloadHash: sha256(hostedUrl),
    },
  })

  return { intentId: intent.id, publicUrl, hostedUrl, returnToken, returnUrl }
}

export async function getAchStatusByInvoice(params: { tenantId: string; invoiceId: string }) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, tenantId: params.tenantId },
    select: { id: true, qboAchEnabled: true, qboSyncId: true, balance: true, status: true },
  })
  if (!invoice) throw new Error('Invoice not found.')

  const latest = await prisma.invoicePaymentIntent.findFirst({
    where: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      provider: 'qbo',
      method: 'ach',
    },
    orderBy: { createdAt: 'desc' },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  })

  return { invoice, latest }
}

