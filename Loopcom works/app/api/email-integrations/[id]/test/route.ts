import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { decryptSecrets } from '@/lib/integrations/secrets'

const schema = z.object({
  toEmail: z.string().email().optional(),
})

function isAdmin(user: { role?: string }) {
  return String(user.role || '') === 'ADMIN'
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const integration = await db.emailIntegration.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  })
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = schema.parse(body)
    const toEmail = parsed.toEmail || user.email

    const secrets = decryptSecrets(integration.encryptedCredentials)
    const smtpUser = String(secrets.smtpUser || '').trim()
    const smtpAppPassword = String(secrets.smtpAppPassword || '').trim()
    if (!smtpUser || !smtpAppPassword) {
      return NextResponse.json({ error: 'Missing SMTP credentials' }, { status: 400 })
    }

    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpAppPassword },
    })

    await transporter.sendMail({
      from: `${integration.fromName || integration.displayName} <${integration.fromEmail}>`,
      to: toEmail,
      replyTo: integration.replyToEmail || undefined,
      subject: `TrimPro test: ${integration.displayName}`,
      html: '<p>This is a test email from your TrimPro Email Integration.</p>',
      text: 'This is a test email from your TrimPro Email Integration.',
    })

    await db.emailIntegration.update({
      where: { id: integration.id },
      data: {
        status: 'ACTIVE',
        lastError: null,
        lastTestedAt: new Date(),
      },
    })

    return NextResponse.json({ success: true, message: `Test email sent to ${toEmail}` })
  } catch (error: any) {
    await db.emailIntegration.update({
      where: { id: integration.id },
      data: {
        status: 'ERROR',
        lastError: error?.message || 'Failed to send test email',
        lastTestedAt: new Date(),
      },
    })
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    return NextResponse.json(
      { success: false, error: error?.message || 'Test failed' },
      { status: 500 }
    )
  }
}
