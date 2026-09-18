import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/provider'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messaging.email')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const email = await prisma.email.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!email) {
      return NextResponse.json({ error: 'Email not found' }, { status: 404 })
    }

    if (email.status === 'SENT' || email.status === 'DELIVERED') {
      return NextResponse.json({ error: 'Email already sent successfully' }, { status: 400 })
    }

    const fromEmail = process.env.EMAIL_FROM || 'noreply@trimpro.com'
    const replyTo = process.env.EMAIL_REPLY_TO || fromEmail

    // Retry sending
    const sendResult = await sendEmail({
      to: email.toEmails,
      subject: email.subject,
      html: email.bodyHtml || undefined,
      text: email.body || undefined,
      from: fromEmail,
      replyTo,
      metadata: email.providerData || {},
    })

    // Update email record
    const updated = await prisma.email.update({
      where: { id: params.id },
      data: {
        status: sendResult.success ? 'SENT' : 'FAILED',
        providerId: sendResult.messageId || email.providerId,
        providerData: sendResult,
        sentAt: sendResult.success ? new Date() : email.sentAt,
      },
    })

    if (!sendResult.success) {
      return NextResponse.json(
        { error: sendResult.error || 'Failed to retry email', email: updated },
        { status: 500 }
      )
    }

    return NextResponse.json({ email: updated, success: true })
  } catch (error) {
    console.error('Retry email error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
