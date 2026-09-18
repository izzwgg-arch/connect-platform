import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { decryptSecrets } from '@/lib/integrations/secrets'

const schema = z.object({
  toEmail: z.string().email().optional(),
})

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError
  const user = getAuthUser(request)
  const db = prisma as any

  const profile = await db.userEmailSenderProfile.findUnique({
    where: { userId: user.id },
  })
  if (!profile || !profile.isActive) {
    return NextResponse.json({ error: 'Your profile sender is not configured.' }, { status: 400 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = schema.parse(body)
    const toEmail = parsed.toEmail || user.email
    const secrets = decryptSecrets(profile.encryptedCredentials)
    const appPassword = String(secrets.appPassword || '').trim()
    if (!appPassword) {
      return NextResponse.json({ error: 'Missing app password.' }, { status: 400 })
    }

    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: profile.fromEmail,
        pass: appPassword,
      },
    })

    await transporter.sendMail({
      from: `${profile.fromName || 'Trim Pro'} <${profile.fromEmail}>`,
      to: toEmail,
      replyTo: profile.replyToEmail || undefined,
      subject: 'Trim Pro profile sender test',
      text: 'This is a test email from your profile sender configuration.',
      html: '<p>This is a test email from your profile sender configuration.</p>',
    })

    await db.userEmailSenderProfile.update({
      where: { id: profile.id },
      data: {
        status: 'ACTIVE',
        lastError: null,
        lastTestedAt: new Date(),
      },
    })

    return NextResponse.json({ success: true, message: `Test email sent to ${toEmail}` })
  } catch (error: any) {
    await db.userEmailSenderProfile.update({
      where: { id: profile.id },
      data: {
        status: 'ERROR',
        lastError: error?.message || 'Failed to send test email',
        lastTestedAt: new Date(),
      },
    })
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    return NextResponse.json({ error: error?.message || 'Test failed' }, { status: 500 })
  }
}
