import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { getEmailBranding } from '@/lib/email/branding'
import { parseEmailList } from '@/lib/email/recipients'
import { buildInvoiceEmail } from '@/lib/email/templates/invoice'
import { getPdfBranding } from '@/lib/branding/pdf'
import { renderInvoiceEmailPdfAttachment } from '@/lib/documents/email-pdf-attachments'
import { loadEmailEntityAttachments } from '@/lib/documents/email-entity-attachments'
import { formatAddressParts } from '@/lib/address/parse'

function formatEmailSentDate(value: Date | number | string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
  return `${datePart} • ${timePart}`
}

export type SendInvoiceEmailResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

/**
 * Emails an invoice to its client — the shared logic behind the "Send Invoice"
 * dashboard button (app/api/invoices/[id]/send/route.ts) and any automated
 * trigger (e.g. estimate-approval auto-invoicing) that needs the same PDF
 * attachment, payment link, and Email/Activity record-keeping without going
 * through staff auth.
 */
export async function sendInvoiceEmailForInvoice(params: {
  tenantId: string
  invoiceId: string
  /** Acting staff user, if any — omitted for system/automated sends. */
  userId?: string | null
  userEmail?: string | null
  email?: string
  emails?: string[]
  subject?: string
  message?: string
}): Promise<SendInvoiceEmailResult> {
  const { tenantId, invoiceId, userId = null, userEmail = null, email, emails, subject, message } = params

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: {
      client: {
        include: {
          contacts: { where: { isPrimary: true }, take: 1 },
        },
      },
      lineItems: { orderBy: { sortOrder: 'asc' }, include: { group: true } },
      optionalItems: { orderBy: { sortOrder: 'asc' } },
      job: {
        select: {
          id: true,
          jobNumber: true,
          title: true,
          addresses: { where: { type: 'job_site' }, take: 1 },
        },
      },
      estimate: { select: { jobSiteAddress: true } },
    },
  })

  if (!invoice) {
    return { ok: false, status: 404, error: 'Invoice not found' }
  }

  // Prefer explicit recipients from the contact picker / custom emails.
  // Only fall back to client email when the caller did not pass any recipients.
  const explicitRecipients = parseEmailList([...parseEmailList(emails), ...parseEmailList(email)])
  const uniqueRecipientEmails =
    explicitRecipients.length > 0
      ? explicitRecipients
      : parseEmailList([
          ...parseEmailList(invoice.client?.email),
          ...parseEmailList(invoice.client?.contacts?.[0]?.email),
        ])

  if (uniqueRecipientEmails.length === 0) {
    return { ok: false, status: 400, error: 'No recipient email address provided' }
  }

  // Force public base URL in recipient emails to avoid internal/private links.
  const appUrl = 'https://app.trimprony.com'

  const token = invoice.paymentToken || randomUUID()
  const sentEpoch = Date.now()
  const sentIso = new Date(sentEpoch).toISOString()
  const sentDisplay = formatEmailSentDate(sentEpoch)
  if (!invoice.paymentToken) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { paymentToken: token } })
  }

  const pdfUrl = `${appUrl}/api/public/invoices/${invoice.id}/pdf?token=${encodeURIComponent(token)}&view=customer&sent=${sentEpoch}`
  const paymentLink =
    invoice.balance.toNumber() > 0
      ? `${appUrl}/portal/pay/${invoice.id}?token=${encodeURIComponent(token)}&sent=${sentEpoch}`
      : ''
  const jobSiteAddress =
    formatAddressParts(invoice.job?.addresses?.[0]) ||
    (invoice.estimate?.jobSiteAddress ? String(invoice.estimate.jobSiteAddress) : null)
  const defaultSubject = jobSiteAddress ? `Invoice for ${jobSiteAddress}` : `Invoice ${invoice.invoiceNumber}`
  const effectiveSubject = `${subject || defaultSubject} • ${sentDisplay || sentIso}`

  const emailSecrets = await getIntegrationSecrets(tenantId, 'email')
  if (!emailSecrets) {
    return { ok: false, status: 400, error: 'Email integration is not configured. Please configure Email Provider first.' }
  }

  const total = Number(invoice.total || 0).toFixed(2)
  const balance = Number(invoice.balance || 0).toFixed(2)
  const dueDate = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : ''
  const emailBranding = await getEmailBranding(tenantId)
  const logoUrl = emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || ''

  const html = buildInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.client?.companyName || invoice.client?.name || 'Customer',
    title: invoice.title || undefined,
    dueDate: dueDate || undefined,
    total,
    balance,
    sentDisplay: sentDisplay || sentIso,
    pdfUrl,
    paymentLink: paymentLink || undefined,
    message: message ? String(message) : undefined,
    logoUrl: logoUrl || undefined,
    companyName:
      (emailBranding as { businessName?: string; companyName?: string } | null)?.businessName ||
      (emailBranding as { companyName?: string } | null)?.companyName ||
      'TrimPro',
  })

  const pdfBranding = await getPdfBranding(tenantId)
  const pdfAttachment = await renderInvoiceEmailPdfAttachment(invoice, pdfBranding, 'customer')
  const uploadedAttachments = await loadEmailEntityAttachments({
    tenantId,
    entityType: 'invoice',
    entityId: invoice.id,
  })
  const text = `Invoice ${invoice.invoiceNumber}

${message ? String(message) : `Please review invoice ${invoice.invoiceNumber}.`}

Total: $${total}
Balance: $${balance}
${dueDate ? `Due date: ${dueDate}\n` : ''}Download PDF: ${pdfUrl}
${paymentLink ? `Pay Online: ${paymentLink}` : ''}`.trim()

  const sendResult = await sendEmailWithAttachments({
    secrets: emailSecrets,
    to: uniqueRecipientEmails,
    subject: effectiveSubject,
    html,
    text,
    attachments: [pdfAttachment, ...uploadedAttachments],
  })
  if (!sendResult.success) {
    console.error('Failed to send invoice email:', sendResult.error || sendResult.message)
    return { ok: false, status: 502, error: sendResult.error || sendResult.message || 'Failed to send invoice email' }
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: invoice.status === 'DRAFT' ? 'SENT' : invoice.status,
      sentAt: new Date(),
    },
  })

  const fromEmailForRecord =
    userEmail ||
    String((emailSecrets as Record<string, any>).fromEmail || (emailSecrets as Record<string, any>).emailFrom || 'noreply@trimprony.com')

  await prisma.email.create({
    data: {
      tenantId,
      userId,
      direction: 'OUTBOUND',
      status: 'SENT',
      subject: effectiveSubject,
      body: message || `Please find attached invoice ${invoice.invoiceNumber}.`,
      fromEmail: fromEmailForRecord,
      toEmails: uniqueRecipientEmails,
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      sentAt: new Date(),
    },
  })

  await prisma.activity.create({
    data: {
      tenantId,
      userId,
      type: 'EMAIL_SENT',
      description: `Invoice "${invoice.title}" sent to ${uniqueRecipientEmails.join(', ')}`,
      invoiceId: invoice.id,
      clientId: invoice.clientId,
    },
  })

  return { ok: true }
}
