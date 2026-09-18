import { sendEmail } from '@/lib/email/provider'
import { getEmailBranding } from '@/lib/email/branding'
import { buildStaffNotificationEmail } from '@/lib/email/templates/staff-notification'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { getPublicBaseUrl } from '@/lib/public-url'

function absoluteActionUrl(linkUrl?: string | null): string | null {
  const raw = String(linkUrl || '').trim()
  if (!raw) return `${getPublicBaseUrl()}/dashboard`
  if (/^https?:\/\//i.test(raw)) return raw
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return `${getPublicBaseUrl()}${path}`
}

export async function sendStaffNotificationEmail(params: {
  tenantId: string
  to: string
  recipientName?: string | null
  title: string
  message?: string | null
  linkUrl?: string | null
  notificationId?: string
}): Promise<{ sent: boolean; error?: string }> {
  const email = String(params.to || '').trim()
  if (!email) return { sent: false, error: 'missing_email' }

  try {
    const branding = await getEmailBranding(params.tenantId).catch(() => null)
    const built = buildStaffNotificationEmail({
      recipientName: params.recipientName,
      title: params.title,
      message: params.message,
      actionUrl: absoluteActionUrl(params.linkUrl),
      companyName:
        (branding as any)?.invoiceBusinessName ||
        (branding as any)?.emailFromName ||
        'TrimPro',
      logoUrl:
        (branding as any)?.emailLogoUrl ||
        (branding as any)?.webLogoUrl ||
        null,
    })

    // Production uses the tenant email integration (same path as invoices).
    const emailSecrets = await getIntegrationSecrets(params.tenantId, 'email').catch(() => null)
    if (emailSecrets) {
      const sendResult = await sendEmailWithAttachments({
        secrets: emailSecrets,
        to: email,
        subject: built.subject,
        html: built.html,
        text: built.text,
        skipGlobalCc: true,
      })
      if (!sendResult.success) {
        return {
          sent: false,
          error: sendResult.error || sendResult.message || 'send_failed',
        }
      }
      console.info('email.send', {
        emailType: 'staff_notification',
        notificationId: params.notificationId || null,
        sendSource: 'lib/notifications/email.integration',
        toCount: 1,
      })
      return { sent: true }
    }

    // Fallback for envs that still use EMAIL_/RESEND_ env keys.
    const result = await sendEmail({
      to: email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      skipGlobalCc: true,
      metadata: {
        emailType: 'staff_notification',
        notificationId: params.notificationId || null,
        sendSource: 'lib/notifications/email.env_fallback',
      },
    })

    if (!result.success) {
      return {
        sent: false,
        error:
          result.error ||
          'email_not_configured (set Settings > Integrations > Email, or EMAIL_API_KEY)',
      }
    }
    return { sent: true }
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : 'send_failed',
    }
  }
}
