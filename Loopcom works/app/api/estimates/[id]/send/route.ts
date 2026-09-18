import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { isValidEmail } from '@/lib/email'
import { parseEmailList } from '@/lib/email/recipients'
import { getOrCreateEstimateApprovalToken } from '@/lib/estimate-approval'
import { getEmailBranding } from '@/lib/email/branding'
import { buildEstimateApprovalEmail } from '@/lib/email/templates/estimate-approval'
import { getPdfBranding } from '@/lib/branding/pdf'
import { renderEstimateEmailPdfAttachment } from '@/lib/documents/email-pdf-attachments'
import { loadEmailEntityAttachments } from '@/lib/documents/email-entity-attachments'
import { parseEstimatePdfView } from '@/lib/estimates/estimate-pdf-view'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

export const runtime = 'nodejs'

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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
  return `${datePart} \u2022 ${timePart}`
}


export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'estimates.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { email, emails, subject, message, view: viewRaw } = body
    const pdfView = parseEstimatePdfView(viewRaw)

    // Get estimate
    const estimate = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
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
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    // Prefer explicit recipients from the contact picker / custom emails.
    // Only fall back to client contacts when the caller did not pass any recipients
    // (legacy/API callers). Never auto-append client contacts on top of a selection.
    const explicitRecipients = parseEmailList([
      ...parseEmailList(emails),
      ...parseEmailList(email),
    ])
    const uniqueRecipientEmails =
      explicitRecipients.length > 0
        ? explicitRecipients
        : parseEmailList([
            ...parseEmailList(estimate.client?.email),
            ...(estimate.client?.contacts || []).flatMap((c) => parseEmailList(c.email)),
          ])

    if (uniqueRecipientEmails.length === 0) {
      return NextResponse.json({ error: 'No recipient email address provided' }, { status: 400 })
    }

    const invalidRecipients = uniqueRecipientEmails.filter((addr) => !isValidEmail(addr))
    if (invalidRecipients.length) {
      return NextResponse.json(
        { error: `Invalid recipient email(s): ${invalidRecipients.join(', ')}` },
        { status: 400 }
      )
    }

    // Force public base URL in recipient emails to avoid internal/private links.
    const appUrl = 'https://app.trimprony.com'

    const sentEpoch = Date.now()
    const sentIso = new Date(sentEpoch).toISOString()
    const sentDisplay = formatEmailSentDate(sentEpoch)
    const approvalToken = await getOrCreateEstimateApprovalToken({
      tenantId: user.tenantId,
      estimateId: estimate.id,
    })
    const approveUrl = approvalToken.url
    // View portal — works on every device without needing a PDF viewer.
    const viewUrl = `${appUrl}/portal/estimates/${approvalToken.rawToken}`
    const defaultSubject = estimate.jobSiteAddress
      ? `Estimate for ${estimate.jobSiteAddress}`
      : `Estimate ${estimate.estimateNumber}`
    const effectiveSubject = `${subject || defaultSubject} - ${sentDisplay || sentIso}`
    
    const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')
    if (!emailSecrets) {
      return NextResponse.json(
        { error: 'Email integration is not configured. Please configure Email Provider first.' },
        { status: 400 }
      )
    }

    const customerName = estimate.client?.companyName || estimate.client?.name || `${estimate.title || ''}`.trim() || 'Customer'
    const validUntil = estimate.validUntil ? new Date(estimate.validUntil).toLocaleDateString() : ''
    const emailBranding = await getEmailBranding(user.tenantId)
    // Use the public URL directly — Gmail/Outlook block data: URIs in emails.
    const logoUrl = emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || undefined

    const html = buildEstimateApprovalEmail({
      recipientName: customerName,
      customerName,
      estimateNumber: estimate.estimateNumber,
      total: `$${Number(estimate.total || 0).toFixed(2)}`,
      sentDisplay: sentDisplay || sentIso,
      approveUrl,
      viewUrl,
      message: message ? String(message) : undefined,
      validUntil: validUntil || undefined,
      logoUrl: logoUrl || undefined,
      companyName: (emailBranding as any)?.businessName || (emailBranding as any)?.companyName || 'TrimPro',
      supportEmail: (emailBranding as any)?.supportEmail || (emailBranding as any)?.businessEmail || undefined,
    })

    const results: Array<{
      recipient: string
      success: boolean
      message?: string
      error?: string
    }> = []

    const itemApprovals = await prisma.estimateItemApproval.findMany({
      where: { estimateId: estimate.id, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedOptionalItemIds = new Set(itemApprovals.map((approval) => approval.estimateLineItemId))
    const pdfBranding = await getPdfBranding(user.tenantId)
    const pdfAttachment = await renderEstimateEmailPdfAttachment(
      estimate,
      pdfBranding,
      approvedOptionalItemIds,
      pdfView
    )
    const uploadedAttachments = await loadEmailEntityAttachments({
      tenantId: user.tenantId,
      entityType: 'estimate',
      entityId: estimate.id,
    })
    const text = `Estimate ${estimate.estimateNumber}

${message ? String(message) : `Please review estimate ${estimate.estimateNumber}.`}

Total: $${Number(estimate.total || 0).toFixed(2)}
${validUntil ? `Valid until: ${validUntil}\n` : ''}View estimate: ${viewUrl}
Approve estimate: ${approveUrl}`.trim()

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: uniqueRecipientEmails,
      subject: effectiveSubject,
      html,
      text,
      attachments: [pdfAttachment, ...uploadedAttachments],
    })
    for (const recipientEmail of uniqueRecipientEmails) {
      results.push({
        recipient: recipientEmail,
        success: !!sendResult.success,
        message: sendResult.message,
        error: sendResult.error,
      })
    }

    const sentRecipients = results.filter((r) => r.success).map((r) => r.recipient)
    const failedRecipients = results.filter((r) => !r.success)

    if (sentRecipients.length === 0) {
      const firstError = failedRecipients[0]?.error || failedRecipients[0]?.message || 'Failed to send estimate email'
      console.error('Failed to send estimate email:', firstError)
      return NextResponse.json({ error: firstError, failedRecipients }, { status: 502 })
    }

    // Update estimate status
    await prisma.estimate.update({
      where: { id: params.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'estimate', estimate.id, { processImmediately: false })
    } catch (error) {
      console.error('QuickBooks estimate sync trigger error (estimate send):', error)
    }

    // Advance linked request status from ESTIMATE_CREATED → ESTIMATE_SENT (idempotent: skip if already sent or further along)
    const ADVANCE_FROM_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'ESTIMATE_CREATED'] as const
    if (estimate.leadId) {
      const linkedLead = await prisma.lead.findUnique({
        where: { id: estimate.leadId },
        select: { id: true, status: true },
      })
      if (linkedLead && (ADVANCE_FROM_STATUSES as readonly string[]).includes(linkedLead.status)) {
        await prisma.lead.update({
          where: { id: linkedLead.id },
          data: { status: 'ESTIMATE_SENT' },
        })
      }
    }

    // Create email record
    await prisma.email.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        direction: 'OUTBOUND',
        status: failedRecipients.length ? 'FAILED' : 'SENT',
        subject: effectiveSubject,
        body: message || `Please find attached estimate ${estimate.estimateNumber}.`,
        fromEmail: user.email,
        toEmails: sentRecipients,
        providerData: {
          recipients: results,
        },
        estimateId: estimate.id,
        clientId: estimate.clientId || undefined,
        sentAt: new Date(),
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'ESTIMATE_SENT',
        description: failedRecipients.length
          ? `Estimate "${estimate.title}" sent to ${sentRecipients.join(', ')} (failed: ${failedRecipients
              .map((r) => r.recipient)
              .join(', ')})`
          : `Estimate "${estimate.title}" sent to ${sentRecipients.join(', ')}`,
        estimateId: estimate.id,
        clientId: estimate.clientId || undefined,
        leadId: estimate.leadId || undefined,
      },
    })

    return NextResponse.json({
      message: failedRecipients.length ? 'Estimate sent (some recipients failed)' : 'Estimate sent successfully',
      sentRecipients,
      failedRecipients: failedRecipients.map((r) => ({ recipient: r.recipient, error: r.error || r.message || '' })),
    })
  } catch (error) {
    console.error('Send estimate error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
