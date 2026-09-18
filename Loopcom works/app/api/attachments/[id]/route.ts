import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['jobs.view', 'leads.view', 'clients.view', 'purchase_orders.view'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const attachment = await prisma.attachment.findUnique({
      where: { id: params.id },
      include: {
        estimate: { select: { tenantId: true } },
        invoice: { select: { tenantId: true } },
        purchaseOrder: { select: { tenantId: true } },
        job: { select: { tenantId: true } },
        task: { select: { tenantId: true } },
        issue: { select: { tenantId: true } },
        lead: { select: { tenantId: true } },
      },
    })

    if (!attachment) {
      return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
    }

    const tenantId =
      attachment.estimate?.tenantId ||
      attachment.invoice?.tenantId ||
      attachment.purchaseOrder?.tenantId ||
      attachment.job?.tenantId ||
      attachment.task?.tenantId ||
      attachment.issue?.tenantId ||
      attachment.lead?.tenantId ||
      null

    if (!tenantId || tenantId !== user.tenantId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (attachment.leadId) {
      const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
      await Promise.all([
        prisma.activity.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            type: 'OTHER',
            description: `REQUEST_ATTACHMENT_REMOVED: ${attachment.fileName}`,
            leadId: attachment.leadId,
          },
        }),
        prisma.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: 'DELETE',
            entityType: 'RequestAttachment',
            entityId: attachment.id,
            ipAddress,
            userAgent: request.headers.get('user-agent') || undefined,
            changes: {
              requestId: attachment.leadId,
              fileName: attachment.fileName,
              key: attachment.key,
            },
          },
        }),
      ])
    }

    await prisma.attachment.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Delete attachment error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
