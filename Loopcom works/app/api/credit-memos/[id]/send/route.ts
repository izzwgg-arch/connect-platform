import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { isValidEmail } from '@/lib/email'
import { parseEmailList } from '@/lib/email/recipients'
import { getEmailBranding } from '@/lib/email/branding'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildCreditMemoEmail } from '@/lib/email/templates/credit-memo'
import { renderCreditMemoEmailPdfAttachment } from '@/lib/documents/email-pdf-attachments'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { email, emails, subject, message } = body || {}

    const creditMemo = await prisma.creditMemo.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            companyName: true,
            email: true,
            contacts: { where: { isPrimary: true }, take: 1 },
          },
        },
        job: { select: { id: true, jobNumber: true, title: true } },
        sourceInvoice: { select: { id: true, invoiceNumber: true } },
        lineItems: { orderBy: { sortOrder: 'asc' } },
      },
    })

    if (!creditMemo) {
      return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 })
    }
    if (creditMemo.status === 'VOID') {
      return NextResponse.json({ error: 'Cannot send a voided credit memo' }, { status: 400 })
    }

    const recipients = (() => {
      const explicit = parseEmailList([...parseEmailList(emails), ...parseEmailList(email)])
      if (explicit.length) return explicit
      return parseEmailList([
        creditMemo.client?.email,
        ...(creditMemo.client?.contacts || []).map((c) => c.email),
      ])
    })()

    if (!recipients.length) {
      return NextResponse.json({ error: 'No recipient email address provided' }, { status: 400 })
    }
    const invalid = recipients.filter((addr) => !isValidEmail(addr))
    if (invalid.length) {
      return NextResponse.json(
        { error: `Invalid recipient email(s): ${invalid.join(', ')}` },
        { status: 400 }
      )
    }

    const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')
    if (!emailSecrets) {
      return NextResponse.json(
        { error: 'Email integration is not configured. Please configure Email Provider first.' },
        { status: 400 }
      )
    }

    const emailBranding = await getEmailBranding(user.tenantId)
    const pdfBrand = await getPdfBranding(user.tenantId)
    const logoUrl = emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || ''
    const companyName =
      (emailBranding as any)?.businessName ||
      (emailBranding as any)?.companyName ||
      pdfBrand.businessName ||
      'Trim Pro'
    const clientName =
      creditMemo.client?.companyName || creditMemo.client?.name || 'Customer'

    const pdfAttachment = await renderCreditMemoEmailPdfAttachment(creditMemo, pdfBrand)
    const html = buildCreditMemoEmail({
      creditMemoNumber: creditMemo.creditMemoNumber,
      clientName,
      total: Number(creditMemo.total).toFixed(2),
      remaining: Number(creditMemo.remainingCredit).toFixed(2),
      message: message ? String(message) : undefined,
      logoUrl: logoUrl || undefined,
      companyName,
    })

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: recipients,
      subject: subject || `Credit Memo ${creditMemo.creditMemoNumber} from ${companyName}`,
      html,
      text: `Credit Memo ${creditMemo.creditMemoNumber}\nTotal: $${Number(creditMemo.total).toFixed(2)}\nRemaining: $${Number(creditMemo.remainingCredit).toFixed(2)}`,
      attachments: [pdfAttachment],
    })

    if (!sendResult.success) {
      return NextResponse.json(
        { error: sendResult.error || sendResult.message || 'Failed to send credit memo email' },
        { status: 502 }
      )
    }

    const updated = await prisma.creditMemo.update({
      where: { id: creditMemo.id },
      data: {
        status: creditMemo.status === 'DRAFT' ? 'SENT' : creditMemo.status,
        sentAt: new Date(),
      },
    })

    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Credit memo ${creditMemo.creditMemoNumber} sent to ${recipients.join(', ')}`,
        creditMemoId: creditMemo.id,
        clientId: creditMemo.clientId,
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'credit_memo', creditMemo.id)
    } catch (e) {
      console.error('QBO credit memo sync trigger error (send):', e)
    }

    return NextResponse.json({
      message: 'Credit memo sent successfully',
      recipients,
      creditMemo: {
        ...updated,
        total: Number(updated.total),
        remainingCredit: Number(updated.remainingCredit),
        appliedAmount: Number(updated.appliedAmount),
      },
    })
  } catch (error) {
    console.error('Send credit memo error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
