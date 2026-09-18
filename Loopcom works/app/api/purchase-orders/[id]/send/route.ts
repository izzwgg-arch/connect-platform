import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { isValidEmail } from '@/lib/email'
import { parseEmailList } from '@/lib/email/recipients'
import { getEmailBranding } from '@/lib/email/branding'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildPurchaseOrderEmail } from '@/lib/email/templates/purchase-order'
import { renderPurchaseOrderEmailPdfAttachment } from '@/lib/documents/email-pdf-attachments'
import { loadEmailEntityAttachments } from '@/lib/documents/email-entity-attachments'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { email, emails, subject, message } = body

    // Get purchase order
    const purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        vendorRef: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            contactPerson: true,
          },
        },
        lineItems: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        job: {
          include: {
            addresses: {
              where: { type: 'job_site' },
              take: 1,
            },
            client: {
              select: { id: true, name: true },
            },
          },
        },
      },
    })

    if (!purchaseOrder) {
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    const uniqueRecipientEmails = parseEmailList([
      ...parseEmailList(emails),
      ...parseEmailList(email),
    ])
    const recipients =
      uniqueRecipientEmails.length > 0
        ? uniqueRecipientEmails
        : parseEmailList(purchaseOrder.vendorRef?.email)

    if (recipients.length === 0) {
      return NextResponse.json(
        { error: 'No email address found for vendor. Please provide an email address.' },
        { status: 400 }
      )
    }
    const invalidRecipients = recipients.filter((addr) => !isValidEmail(addr))
    if (invalidRecipients.length) {
      return NextResponse.json(
        { error: `Invalid recipient email(s): ${invalidRecipients.join(', ')}` },
        { status: 400 }
      )
    }

    const total = Number(purchaseOrder.total).toFixed(2)
    const vendorCompany =
      purchaseOrder.vendorRef?.name || purchaseOrder.vendor || 'Vendor'
    const vendorName =
      purchaseOrder.vendorRef?.contactPerson || vendorCompany
    const orderDate = purchaseOrder.orderDate
      ? new Date(purchaseOrder.orderDate).toLocaleDateString('en-US', {
          month: '2-digit',
          day: '2-digit',
          year: 'numeric',
        })
      : new Date().toLocaleDateString('en-US', {
          month: '2-digit',
          day: '2-digit',
          year: 'numeric',
        })

    const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')
    if (!emailSecrets) {
      return NextResponse.json(
        { error: 'Email integration is not configured. Please configure Email Provider first.' },
        { status: 400 }
      )
    }

    const emailBranding = await getEmailBranding(user.tenantId)
    const pdfBrand = await getPdfBranding(user.tenantId)
    const companyName =
      (emailBranding as { businessName?: string; companyName?: string } | null)?.businessName ||
      (emailBranding as { companyName?: string } | null)?.companyName ||
      pdfBrand.businessName ||
      'Trim Pro'

    const senderUser = await prisma.user.findFirst({
      where: { id: user.id, tenantId: user.tenantId },
      select: { firstName: true, lastName: true, email: true, phone: true },
    })
    const senderName = senderUser
      ? `${senderUser.firstName} ${senderUser.lastName}`.trim()
      : 'Purchasing'
    const senderPhone = senderUser?.phone || undefined
    const senderEmail = senderUser?.email || user.email || undefined

    const pdfAttachment = await renderPurchaseOrderEmailPdfAttachment(purchaseOrder, {
      logoUrl: pdfBrand.logoUrl,
      businessName: pdfBrand.businessName,
    })
    const uploadedAttachments = await loadEmailEntityAttachments({
      tenantId: user.tenantId,
      entityType: 'purchase_order',
      entityId: purchaseOrder.id,
    })
    const html = buildPurchaseOrderEmail({
      poNumber: purchaseOrder.poNumber,
      vendorName,
      total: `$${total}`,
      orderDate,
      message: message ? String(message) : undefined,
      senderName,
      senderRole: 'Purchasing',
      senderPhone,
      senderEmail,
    })
    const text = `
Dear ${vendorName},

${message?.trim() || 'Please find our purchase order attached to this email. Thank You!'}

${senderName} / Purchasing
${senderPhone ? `P - ${senderPhone}` : ''}
${senderEmail ? `E - ${senderEmail}` : ''}

----------------------- Purchase Order Summary -----------------------
Purchase Order #: ${purchaseOrder.poNumber}
Purchase Order Date: ${orderDate}
Total: $${total}

The complete version has been provided as an attachment to this email.
----------------------------------------------------------
`.trim()

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: recipients,
      subject: subject || `Purchase Order ${purchaseOrder.poNumber} from ${companyName}`,
      html,
      text,
      attachments: [pdfAttachment, ...uploadedAttachments],
    })
    if (!sendResult.success) {
      return NextResponse.json(
        { error: sendResult.error || sendResult.message || 'Failed to send purchase order email' },
        { status: 502 }
      )
    }

    // Update status to ORDERED if it was APPROVED or DRAFT
    if (purchaseOrder.status === 'APPROVED' || purchaseOrder.status === 'DRAFT') {
      await prisma.purchaseOrder.update({
        where: { id: params.id },
        data: { status: 'ORDERED' },
      })
    }

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Purchase order ${purchaseOrder.poNumber} sent to ${recipients.join(', ')}`,
        purchaseOrderId: purchaseOrder.id,
      },
    })

    try {
      await enqueueQboSync(user.tenantId, 'purchase_order', params.id)
    } catch (error) {
      console.error('QuickBooks purchase order sync trigger error (send):', error)
    }

    return NextResponse.json({
      message: 'Purchase order sent successfully',
      recipients,
      purchaseOrder: {
        ...purchaseOrder,
        status: purchaseOrder.status === 'APPROVED' || purchaseOrder.status === 'DRAFT' ? 'ORDERED' : purchaseOrder.status,
      },
    })
  } catch (error) {
    console.error('Send purchase order error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
