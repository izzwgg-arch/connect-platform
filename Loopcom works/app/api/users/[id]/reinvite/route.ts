import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { generatePasswordResetToken } from '@/lib/auth'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { testEmailProvider } from '@/lib/integrations/providers/email'
import { buildInviteEmailHtml, sendInviteEmail } from '@/lib/services/email'
import { getEmailBranding } from '@/lib/email/branding'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'users.create')
  if (permError) return permError

  const actor = getAuthUser(request)

  try {
    const targetUser = await prisma.user.findFirst({
      where: {
        id: params.id,
        tenantId: actor.tenantId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        status: true,
      },
    })

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const inviteToken = generatePasswordResetToken('7d')
    const inviteExp = new Date()
    inviteExp.setDate(inviteExp.getDate() + 7)

    await prisma.user.update({
      where: { id: targetUser.id },
      data: {
        passwordResetToken: inviteToken,
        passwordResetExp: inviteExp,
      },
    })

    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.trimprony.com'
    const setPasswordUrl = `${appBaseUrl}/auth/reset-password?token=${encodeURIComponent(inviteToken)}`
    const apkDownloadUrl =
      process.env.TRIMPRO_FIELD_APK_URL ||
      process.env.EXPO_ANDROID_APK_URL ||
      `${appBaseUrl}/download`

    let emailSent = false
    let emailError: string | null = null
    const emailSecrets = await getIntegrationSecrets(actor.tenantId, 'email')
    const emailBranding = await getEmailBranding(actor.tenantId)
    const brandLogoUrl = emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || null

    if (emailSecrets) {
      const html = buildInviteEmailHtml(targetUser.firstName, setPasswordUrl, apkDownloadUrl, brandLogoUrl)
      const sendResult = await testEmailProvider(
        emailSecrets,
        targetUser.email,
        'Welcome to TrimPro - Create Your Password',
        html
      )
      if (!sendResult.success) {
        emailError = sendResult.error || sendResult.message || 'Failed to send invitation email via integration'
      } else {
        emailSent = true
      }
    }

    // Fallback to env/provider-based sender when integration is missing or integration send fails.
    if (!emailSent) {
      try {
        await sendInviteEmail(targetUser.email, targetUser.firstName, setPasswordUrl, apkDownloadUrl, brandLogoUrl)
        emailSent = true
      } catch (fallbackError: any) {
        if (!emailError) {
          emailError = fallbackError?.message || 'Failed to send invitation email'
        } else {
          emailError = `${emailError}; fallback: ${fallbackError?.message || 'failed'}`
        }
      }
    }

    await prisma.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'User',
        entityId: targetUser.id,
        changes: {
          action: 'reinvite_sent',
          email: targetUser.email,
          emailSent,
          emailError,
        },
      },
    })

    return NextResponse.json(
      {
        message: emailSent ? 'Invitation email sent' : 'Reinvite created, but email failed to send',
        emailSent,
        emailError,
      },
      { status: emailSent ? 200 : 502 }
    )
  } catch (error) {
    console.error('Reinvite user error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

