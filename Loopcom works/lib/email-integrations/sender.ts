import { prisma } from '@/lib/prisma'
import { decryptSecrets } from '@/lib/integrations/secrets'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { testEmailProvider } from '@/lib/integrations/providers/email'
import { sendEmail } from '@/lib/email/provider'
import { mergeConfiguredGlobalCc, normalizeRecipients } from '@/lib/email/recipients'

type SenderSource = 'assigned_integration' | 'tenant_email_integration' | 'system_default'
type ExtendedSenderSource = SenderSource | 'user_profile_google_workspace'

interface ResolvedSender {
  source: ExtendedSenderSource
  fromEmail: string
  fromName: string
  replyTo?: string | null
  integrationId?: string | null
  userProfileId?: string | null
}

interface SendDocumentEmailInput {
  tenantId: string
  userId: string
  to: string | string[]
  subject: string
  html: string
  text?: string
}

const SYSTEM_FROM = process.env.EMAIL_FROM || process.env.EMAIL_FROM_NAME || 'noreply@trimpro.com'
const SYSTEM_FROM_NAME = process.env.FROM_NAME || 'Trim Pro'
const SYSTEM_REPLY_TO = process.env.EMAIL_REPLY_TO || SYSTEM_FROM

function formatFromHeader(fromName: string, fromEmail: string) {
  return `${fromName} <${fromEmail}>`
}

async function getAssignedIntegrationSender(tenantId: string, userId: string): Promise<ResolvedSender | null> {
  try {
    const db = prisma as any
    if (typeof db.userEmailIntegrationAssignment?.findUnique !== 'function') return null
    const assignment = await db.userEmailIntegrationAssignment.findUnique({
      where: {
        tenantId_userId: {
          tenantId,
          userId,
        },
      },
      include: {
        integration: true,
      },
    })

    if (!assignment || !assignment.isActive) return null
    const integration = assignment.integration
    if (!integration || integration.tenantId !== tenantId) return null
    if (!integration.isActive || integration.status !== 'ACTIVE') return null

    return {
      source: 'assigned_integration',
      fromEmail: integration.fromEmail,
      fromName: integration.fromName || integration.displayName || SYSTEM_FROM_NAME,
      replyTo: integration.replyToEmail || null,
      integrationId: integration.id,
    }
  } catch {
    return null
  }
}

async function getUserProfileSender(tenantId: string, userId: string): Promise<ResolvedSender | null> {
  try {
    const db = prisma as any
    if (typeof db.userEmailSenderProfile?.findUnique !== 'function') return null
    const profile = await db.userEmailSenderProfile.findUnique({
      where: { userId },
    })
    if (!profile) return null
    if (profile.tenantId !== tenantId) return null
    if (!profile.isActive || profile.status !== 'ACTIVE') return null

    return {
      source: 'user_profile_google_workspace',
      fromEmail: profile.fromEmail,
      fromName: profile.fromName || 'Trim Pro',
      replyTo: profile.replyToEmail || null,
      userProfileId: profile.id,
    }
  } catch {
    return null
  }
}

async function getTenantIntegrationSender(tenantId: string): Promise<ResolvedSender | null> {
  const secrets = await getIntegrationSecrets(tenantId, 'email')
  if (!secrets) return null

  const fromEmail = String(secrets.fromEmail || process.env.EMAIL_FROM || '').trim()
  if (!fromEmail) return null
  const fromName = String(secrets.fromName || secrets.senderName || SYSTEM_FROM_NAME).trim() || SYSTEM_FROM_NAME
  const replyTo = String(secrets.replyTo || '').trim() || null

  return {
    source: 'tenant_email_integration',
    fromEmail,
    fromName,
    replyTo,
  }
}

export async function resolveDocumentEmailSender(tenantId: string, userId: string): Promise<ResolvedSender> {
  const userProfile = await getUserProfileSender(tenantId, userId)
  if (userProfile) return userProfile

  const assigned = await getAssignedIntegrationSender(tenantId, userId)
  if (assigned) return assigned

  const tenantSender = await getTenantIntegrationSender(tenantId)
  if (tenantSender) return tenantSender

  return {
    source: 'system_default',
    fromEmail: SYSTEM_FROM,
    fromName: SYSTEM_FROM_NAME,
    replyTo: SYSTEM_REPLY_TO,
  }
}

async function sendViaUserProfile(
  userProfileId: string,
  sender: ResolvedSender,
  to: string[],
  subject: string,
  html: string,
  text?: string
) {
  const recipients = mergeConfiguredGlobalCc({ to })
  const db = prisma as any
  if (typeof db.userEmailSenderProfile?.findUnique !== 'function') {
    throw new Error('userEmailSenderProfile model not available')
  }
  const profile = await db.userEmailSenderProfile.findUnique({
    where: { id: userProfileId },
  })
  if (!profile) throw new Error('User email sender profile not found')
  const secrets = decryptSecrets(profile.encryptedCredentials)
  const appPassword = String(secrets.appPassword || '').trim()
  if (!appPassword) throw new Error('User profile app password is missing')

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: profile.fromEmail, pass: appPassword },
  })

  const info = await transporter.sendMail({
    from: formatFromHeader(sender.fromName, sender.fromEmail),
    to: recipients.to.join(', '),
    cc: recipients.cc.length ? recipients.cc.join(', ') : undefined,
    subject,
    html,
    text,
    replyTo: sender.replyTo || undefined,
  })

  await db.userEmailSenderProfile.update({
    where: { id: userProfileId },
    data: {
      status: 'ACTIVE',
      lastError: null,
      lastTestedAt: new Date(),
    },
  })
  return info?.messageId || ''
}

async function sendViaAssignedIntegration(
  integrationId: string,
  sender: ResolvedSender,
  to: string[],
  subject: string,
  html: string,
  text?: string
) {
  const recipients = mergeConfiguredGlobalCc({ to })
  const db = prisma as any
  if (typeof db.emailIntegration?.findUnique !== 'function') {
    throw new Error('emailIntegration model not available')
  }
  const integration = await db.emailIntegration.findUnique({
    where: { id: integrationId },
  })
  if (!integration) {
    throw new Error('Assigned email integration not found')
  }
  const secrets = decryptSecrets(integration.encryptedCredentials)
  const smtpUser = String(secrets.smtpUser || '').trim()
  const smtpAppPassword = String(secrets.smtpAppPassword || '').trim()
  if (!smtpUser || !smtpAppPassword) {
    throw new Error('Assigned Google Workspace integration credentials are missing')
  }

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpAppPassword },
  })

  const info = await transporter.sendMail({
    from: formatFromHeader(sender.fromName, sender.fromEmail),
    to: recipients.to.join(', '),
    cc: recipients.cc.length ? recipients.cc.join(', ') : undefined,
    subject,
    html,
    text,
    replyTo: sender.replyTo || undefined,
  })

  await db.emailIntegration.update({
    where: { id: integrationId },
    data: {
      status: 'ACTIVE',
      lastError: null,
      lastTestedAt: new Date(),
    },
  })

  return info?.messageId || ''
}

export async function sendDocumentEmailWithResolvedSender(input: SendDocumentEmailInput) {
  const { tenantId, userId, to, subject, html, text } = input
  const recipients = normalizeRecipients(to)
  const sender = await resolveDocumentEmailSender(tenantId, userId)

  if (sender.source === 'user_profile_google_workspace' && sender.userProfileId) {
    try {
      const messageId = await sendViaUserProfile(
        sender.userProfileId,
        sender,
        recipients,
        subject,
        html,
        text
      )
      return { success: true, sender, messageId }
    } catch (error: any) {
      const db = prisma as any
      if (typeof db.userEmailSenderProfile?.updateMany === 'function') {
        await db.userEmailSenderProfile.updateMany({
          where: { id: sender.userProfileId },
          data: {
            status: 'ERROR',
            lastError: error?.message || 'Failed to send via profile sender',
            lastTestedAt: new Date(),
          },
        })
      }
    }
  }

  if (sender.source === 'assigned_integration' && sender.integrationId) {
    try {
      const messageId = await sendViaAssignedIntegration(
        sender.integrationId,
        sender,
        recipients,
        subject,
        html,
        text
      )
      return { success: true, sender, messageId }
    } catch (error: any) {
      // Do not fail hard on custom sender; fall back to system path.
      const db = prisma as any
      await (db.emailIntegration?.updateMany ?? (() => Promise.resolve()))({
        where: { id: sender.integrationId },
        data: {
          status: 'ERROR',
          lastError: error?.message || 'Failed to send via assigned integration',
          lastTestedAt: new Date(),
        },
      })
    }
  }

  if (sender.source === 'tenant_email_integration') {
    const secrets = await getIntegrationSecrets(tenantId, 'email')
    if (secrets) {
      const result = await testEmailProvider(secrets, recipients, subject, html)
      if (!result.success) {
        return {
          success: false,
          sender,
          error: result.error || result.message || 'Failed to send through tenant email integration',
        }
      }
      return { success: true, sender, messageId: '' }
    }
  }

  const result = await sendEmail({
    to: recipients,
    subject,
    html,
    text,
    from: formatFromHeader(SYSTEM_FROM_NAME, SYSTEM_FROM),
    replyTo: SYSTEM_REPLY_TO,
  })
  if (!result.success) {
    return {
      success: false,
      sender: {
        source: 'system_default' as const,
        fromEmail: SYSTEM_FROM,
        fromName: SYSTEM_FROM_NAME,
        replyTo: SYSTEM_REPLY_TO,
      },
      error: result.error || 'Failed to send email',
    }
  }
  return {
    success: true,
    sender: {
      source: 'system_default' as const,
      fromEmail: SYSTEM_FROM,
      fromName: SYSTEM_FROM_NAME,
      replyTo: SYSTEM_REPLY_TO,
    },
    messageId: result.messageId || '',
  }
}
