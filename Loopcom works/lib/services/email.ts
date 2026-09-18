// Email Service Abstraction
// Supports SendGrid, Mailgun, and AWS SES
import { getEmailBranding } from '@/lib/email/branding'
import { buildPaymentReceiptEmail } from '@/lib/email/templates/payment-receipt'
import { buildInvoiceEmail } from '@/lib/email/templates/invoice'
import { buildEstimateApprovalEmail } from '@/lib/email/templates/estimate-approval'
import { escapeHtml } from '@/lib/email/shell'
import { mergeConfiguredGlobalCc } from '@/lib/email/recipients'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'sendgrid'
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const AWS_SES_REGION = process.env.AWS_SES_REGION || 'us-east-1'
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@trimpro.com'
const FROM_NAME = process.env.FROM_NAME || 'Trim Pro'

function formatEmailDate(value: Date | number | string) {
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
  return `${datePart} • ${timePart}`
}

interface EmailRequest {
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  text?: string
  html?: string
  attachments?: Array<{
    filename: string
    content: string | Buffer
    type?: string
  }>
}

interface EmailResponse {
  messageId: string
  status: string
  provider: string
}

export class EmailService {
  async sendEmail(request: EmailRequest): Promise<EmailResponse> {
    const { to, cc, bcc, globalCc } = mergeConfiguredGlobalCc({
      to: request.to,
      cc: request.cc,
      bcc: request.bcc,
    })
    const requestWithCc: EmailRequest = { ...request, to, cc, bcc }

    console.info('email.send', {
      emailType: 'service-email',
      sendSource: 'lib/services/email',
      toCount: to.length,
      ccCount: cc.length,
      cc,
      globalCcCount: globalCc.length,
    })

    switch (EMAIL_PROVIDER) {
      case 'sendgrid':
        return this.sendViaSendGrid(requestWithCc)
      case 'mailgun':
        return this.sendViaMailgun(requestWithCc)
      case 'ses':
        return this.sendViaSES(requestWithCc)
      default:
        throw new Error(`Unsupported email provider: ${EMAIL_PROVIDER}`)
    }
  }

  private async sendViaSendGrid(request: EmailRequest): Promise<EmailResponse> {
    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured')
    }

    const to = Array.isArray(request.to) ? request.to : [request.to]
    const personalizations = [{
      to: to.map((email) => ({ email })),
      cc: request.cc ? (Array.isArray(request.cc) ? request.cc : [request.cc]).map((email) => ({ email })) : undefined,
      bcc: request.bcc ? (Array.isArray(request.bcc) ? request.bcc : [request.bcc]).map((email) => ({ email })) : undefined,
    }]

    const body = {
      personalizations,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME,
      },
      subject: request.subject,
      content: [
        request.html ? { type: 'text/html', value: request.html } : undefined,
        request.text ? { type: 'text/plain', value: request.text } : undefined,
      ].filter(Boolean),
      attachments: request.attachments?.map((att) => ({
        content: typeof att.content === 'string' ? att.content : att.content.toString('base64'),
        filename: att.filename,
        type: att.type || 'application/octet-stream',
        disposition: 'attachment',
      })),
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.errors?.[0]?.message || error.message || 'SendGrid error')
    }

    return {
      messageId: response.headers.get('x-message-id') || '',
      status: 'sent',
      provider: 'sendgrid',
    }
  }

  private async sendViaMailgun(request: EmailRequest): Promise<EmailResponse> {
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error('Mailgun credentials not configured')
    }

    const formData = new FormData()
    formData.append('from', `${FROM_NAME} <${FROM_EMAIL}>`)
    
    const to = Array.isArray(request.to) ? request.to : [request.to]
    to.forEach((email) => formData.append('to', email))
    
    if (request.cc) {
      const cc = Array.isArray(request.cc) ? request.cc : [request.cc]
      cc.forEach((email) => formData.append('cc', email))
    }
    
    if (request.bcc) {
      const bcc = Array.isArray(request.bcc) ? request.bcc : [request.bcc]
      bcc.forEach((email) => formData.append('bcc', email))
    }
    
    formData.append('subject', request.subject)
    if (request.html) formData.append('html', request.html)
    if (request.text) formData.append('text', request.text)

    if (request.attachments) {
      for (const att of request.attachments) {
        const blob = typeof att.content === 'string' 
          ? new Blob([att.content], { type: att.type || 'application/octet-stream' })
          : new Blob([Buffer.isBuffer(att.content) ? new Uint8Array(att.content) : att.content])
        formData.append('attachment', blob, att.filename)
      }
    }

    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64')}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.message || 'Mailgun error')
    }

    const data = await response.json()
    return {
      messageId: data.id || '',
      status: 'sent',
      provider: 'mailgun',
    }
  }

  private async sendViaSES(request: EmailRequest): Promise<EmailResponse> {
    // AWS SES implementation
    // This would use AWS SDK
    throw new Error('AWS SES implementation pending - use AWS SDK')
  }
}

export const emailService = new EmailService()

// Helper functions for common email types
export async function sendInviteEmail(
  to: string,
  firstName: string,
  setPasswordUrl: string,
  apkDownloadUrl: string,
  logoUrl?: string | null
): Promise<void> {
  const emailService = new EmailService()
  const subject = 'Welcome to TrimPro - Create Your Password'
  const html = buildInviteEmailHtml(firstName, setPasswordUrl, apkDownloadUrl, logoUrl)
  const text = buildInviteEmailText(firstName, setPasswordUrl, apkDownloadUrl)

  await emailService.sendEmail({
    to,
    subject,
    html,
    text,
  })
}

export function buildInviteEmailHtml(
  firstName: string,
  setPasswordUrl: string,
  apkDownloadUrl: string,
  logoUrl?: string | null
): string {
  const safeName = firstName?.trim() || 'there'
  const sentDisplay = formatEmailDate(new Date())
  const safeSetPasswordUrl = escapeHtml(setPasswordUrl)
  const safeApkDownloadUrl = escapeHtml(apkDownloadUrl)
  const safeLogoUrl = escapeHtml(logoUrl || '')
  const headerLogoBlock = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="Brand logo" width="200"
         style="display:inline-block;height:auto;max-height:72px;width:auto;max-width:220px;border:0;margin-bottom:6px;"
         onerror="this.style.display='none'" />`
    : `<div style="font-size:22px;font-weight:800;letter-spacing:-0.3px;color:#f8dea4;margin-bottom:10px;">TrimPro</div>`
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" data-tp-lock-colors="1">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>Welcome to TrimPro</title>
  <style>
    :root { color-scheme: dark; supported-color-schemes: dark; }
    @media only screen and (max-width:600px){
      .main-card { border-radius:12px !important; }
      .hero-pad { padding:28px 20px 20px !important; }
      .body-pad { padding:22px 20px !important; }
      .foot-pad { padding:20px !important; }
      .headline { font-size:24px !important; }
      .btn-cell { display:block !important; width:100% !important; padding:0 0 10px !important; }
      .btn-main { padding:14px 20px !important; font-size:15px !important; }
    }
    @media (prefers-color-scheme: light){
      :root { color-scheme: light; supported-color-schemes: light; }
      .email-body { background-color:#f8f9fc !important; }
      .main-card { background-color:#ffffff !important; box-shadow:0 8px 24px rgba(15,23,42,0.08),0 2px 8px rgba(15,23,42,0.05) !important; }
      .headline { color:#1f2937 !important; }
      .hero-meta { color:#475569 !important; }
      .body-text { color:#1f2937 !important; }
      .status-badge { background-color:#e5e7eb !important; color:#111827 !important; border-color:#f8dea4 !important; }
      .support-card { background-color:#f1f5f9 !important; border-color:#d5dee8 !important; }
      .support-text, .support-strong { color:#111827 !important; }
      .foot-cell { background-color:#f8fafc !important; border-top-color:#e5e7eb !important; }
      .foot-copy { color:#475569 !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0f172a;padding:24px 12px 40px;">
    <tr>
      <td align="center" valign="top">
        <table role="presentation" class="main-card" cellpadding="0" cellspacing="0" border="0"
          style="max-width:580px;width:100%;background-color:#243f53;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.4),0 2px 8px rgba(0,0,0,0.25);">
          <tr>
            <td style="background-color:#243f53;padding:34px 36px 26px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07);">
              ${headerLogoBlock}
              <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#f5e3aa;">
                New Team Invitation
              </p>
            </td>
          </tr>
          <tr>
            <td class="hero-pad" style="padding:30px 40px 22px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07);">
              <div class="status-badge" style="display:inline-block;background-color:#334155;border:1px solid #f8dea4;border-radius:999px;padding:5px 16px;margin-bottom:18px;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.3px;">
                Account Activation
              </div>
              <h1 class="headline" style="margin:0 0 10px;font-size:28px;font-weight:800;line-height:1.2;letter-spacing:-0.4px;color:#f8dea4;">
                Welcome to TrimPro, ${escapeHtml(safeName)}
              </h1>
              <p class="hero-meta" style="margin:0;font-size:13px;font-weight:600;color:#c4d5e9;">
                Invitation sent ${escapeHtml(sentDisplay)}
              </p>
            </td>
          </tr>
          <tr>
            <td class="body-pad" style="padding:26px 40px;">
              <p class="body-text" style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#d5e1f1;">
                Create your password to activate your account, then sign in to start using TrimPro.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background-color:#1e3345;border:1px solid #46627f;border-radius:12px;overflow:hidden;margin-bottom:22px;">
                <tr>
                  <td style="padding:11px 18px;border-bottom:1px solid #46627f;background-color:#1e3345;">
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#c2d1e3;">Activation Details</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 18px;">
                    <p style="margin:0;font-size:13px;line-height:1.7;color:#d5e1f1;word-break:break-all;">
                      ${safeSetPasswordUrl}
                    </p>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
                <tr>
                  <td align="center">
                    <a href="${safeSetPasswordUrl}" style="display:inline-block;padding:16px 48px;font-size:17px;font-weight:700;letter-spacing:0.2px;line-height:1.2;text-decoration:none;text-align:center;border-radius:12px;background:linear-gradient(135deg,#2a5f82 0%,#f0c974 100%);color:#1e2937;margin:0 6px 10px 0;">Create Password</a>
                    <a href="${safeApkDownloadUrl}" style="display:inline-block;padding:16px 48px;font-size:17px;font-weight:700;letter-spacing:0.2px;line-height:1.2;text-decoration:none;text-align:center;border-radius:12px;background:linear-gradient(135deg,#2a5f82 0%,#f0c974 100%);color:#1e2937;">Download Field App</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="support-card" style="background-color:#263f56;border:1px solid #46627f;border-radius:10px;">
                <tr>
                  <td style="padding:13px 18px;text-align:center;">
                    <p class="support-text" style="margin:0;font-size:13px;line-height:1.65;color:#d6e3f2;">
                      Need help getting started? <strong class="support-strong" style="color:#ffffff;">Reply to this email</strong>.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="foot-cell foot-pad" style="background-color:#223347;padding:22px 40px 24px;border-top:1px solid #46627f;text-align:center;">
              <p style="margin:0 0 5px;font-size:13px;font-weight:700;color:#f8dea4;letter-spacing:0.2px;">TrimPro</p>
              <p class="foot-copy" style="margin:0;font-size:11px;line-height:1.6;color:#93a9c2;">This invitation was sent by TrimPro.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function buildInviteEmailText(firstName: string, setPasswordUrl: string, apkDownloadUrl: string): string {
  const safeName = firstName?.trim() || 'there'
  return `
Welcome to TrimPro, ${safeName}!

Your TrimPro account has been created.
Create your password here:
${setPasswordUrl}

After setting your password, you will be redirected to the login page.

Download TrimPro Field App (Android):
${apkDownloadUrl}
  `.trim()
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const emailService = new EmailService()
  
  await emailService.sendEmail({
    to,
    subject: 'Reset Your Password - Trim Pro',
    html: `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f172a;padding:24px 12px 40px;">
      <tr><td align="center">
        <table role="presentation" width="580" cellspacing="0" cellpadding="0" style="max-width:580px;width:100%;background:#243f53;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.4),0 2px 8px rgba(0,0,0,0.25);">
          <tr><td style="background:#243f53;padding:34px 36px 26px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07);">
            <div style="font-size:22px;font-weight:800;letter-spacing:-0.3px;color:#f8dea4;margin-bottom:10px;">TrimPro</div>
            <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#f5e3aa;">Security Notice</p>
          </td></tr>
          <tr><td style="padding:30px 40px 22px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07);">
            <h1 style="margin:0 0 10px;font-size:28px;font-weight:800;line-height:1.2;color:#f8dea4;">Password Reset Request</h1>
            <p style="margin:0;font-size:13px;font-weight:600;color:#c4d5e9;">This link expires in 1 hour.</p>
          </td></tr>
          <tr><td style="padding:26px 40px;">
            <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#d5e1f1;">You requested to reset your password. Use the button below to continue.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:18px;">
              <tr><td align="center">
                <a href="${resetUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:16px 48px;font-size:17px;font-weight:700;letter-spacing:0.2px;line-height:1.2;text-decoration:none;text-align:center;border-radius:12px;background:linear-gradient(135deg,#2a5f82 0%,#f0c974 100%);color:#1e2937;">Reset Password</a>
              </td></tr>
            </table>
            <p style="margin:0;font-size:13px;line-height:1.65;color:#d6e3f2;">If you did not request this, you can safely ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
    text: `
      Password Reset Request
      
      You requested to reset your password. Click the link below to reset it:
      
      ${resetUrl}
      
      This link expires in 1 hour.
      
      If you didn't request this, please ignore this email.
    `,
  })
}

export async function sendEstimateEmail(
  to: string,
  estimate: any,
  pdfUrl: string,
  customMessage?: string
): Promise<void> {
  const emailService = new EmailService()
  const sentDisplay = formatEmailDate(new Date())

  await emailService.sendEmail({
    to,
    subject: `Estimate ${estimate.estimateNumber} from Trim Pro`,
    html: buildEstimateApprovalEmail({
      recipientName: 'there',
      customerName: 'Customer',
      estimateNumber: estimate.estimateNumber,
      total: String(estimate.total || ''),
      sentDisplay,
      approveUrl: pdfUrl,
      pdfUrl,
      message: customMessage,
      validUntil: estimate.validUntil
        ? new Date(estimate.validUntil).toLocaleDateString()
        : undefined,
    }),
    text: `Estimate ${estimate.estimateNumber}\n\n${customMessage || ''}\n\nTotal: ${estimate.total}\n${estimate.validUntil ? `Valid until: ${new Date(estimate.validUntil).toLocaleDateString()}\n` : ''}\nDownload: ${pdfUrl}`,
    attachments: [],
  })
}

export async function sendInvoiceEmail(
  to: string,
  invoice: any,
  pdfUrl: string,
  paymentLink: string,
  customMessage?: string
): Promise<void> {
  const emailService = new EmailService()
  const sentDisplay = formatEmailDate(new Date())

  await emailService.sendEmail({
    to,
    subject: `Invoice ${invoice.invoiceNumber} from Trim Pro`,
    html: buildInvoiceEmail({
      invoiceNumber: invoice.invoiceNumber,
      clientName: 'Customer',
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : undefined,
      total: String(invoice.total || '0'),
      balance: String(invoice.balance ?? invoice.total ?? '0'),
      sentDisplay,
      pdfUrl,
      paymentLink: paymentLink || undefined,
      message: customMessage,
    }),
    text: `Invoice ${invoice.invoiceNumber}\n\n${customMessage || ''}\n\nTotal: ${invoice.total}\n${invoice.dueDate ? `Due date: ${new Date(invoice.dueDate).toLocaleDateString()}\n` : ''}\nDownload: ${pdfUrl}\n${paymentLink ? `Pay Online: ${paymentLink}` : ''}`,
    attachments: [],
  })
}

export async function sendPaymentReceiptEmail(params: {
  to: string | string[]
  tenantId?: string
  recipientName?: string | null
  invoiceNumber: string
  amount: number
  paidAt?: Date | string | null
  reference?: string | null
  companyName?: string | null
  invoiceUrl?: string | null
  receiptUrl?: string | null
  paymentMethod?: string | null
  providerPaymentId?: string | null
  providerInvoiceId?: string | null
  logoUrl?: string | null
  pdfAttachment?: Buffer
  pdfFilename?: string
}): Promise<void> {
  const paidAtText = formatEmailDate(params.paidAt || new Date())
  const amountText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(params.amount || 0)
  )
  const company = params.companyName || FROM_NAME
  const method = params.paymentMethod || 'ACH'
  const providerPaymentId = params.providerPaymentId || params.reference || ''
  const emailBranding = params.tenantId ? await getEmailBranding(params.tenantId) : null
  const effectiveLogoUrl = params.logoUrl || emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || ''

  const subject = `Payment receipt for invoice ${params.invoiceNumber}`
  const html = buildPaymentReceiptEmail({
    recipientName: params.recipientName || 'there',
    amountPaid: amountText,
    paidAt: params.paidAt || new Date(),
    transactionId: providerPaymentId || '-',
    description: `Invoice ${params.invoiceNumber} (${method})`,
    logoUrl: effectiveLogoUrl || undefined,
    companyName: company,
    receiptUrl: params.receiptUrl || undefined,
    invoiceUrl: params.invoiceUrl || undefined,
    invoiceNumber: params.invoiceNumber,
    hasPdfAttachment: Boolean(params.pdfAttachment),
  })

  const text = `
Payment Receipt

Thank you. We received your payment.
Invoice: ${params.invoiceNumber}
Amount paid: ${amountText}
Method: ${method}
Paid at: ${paidAtText}
${providerPaymentId ? `Payment ID: ${providerPaymentId}` : ''}
${params.providerInvoiceId ? `Provider Invoice ID: ${params.providerInvoiceId}` : ''}
${params.reference ? `Reference: ${params.reference}` : ''}
${params.receiptUrl ? `View receipt: ${params.receiptUrl}` : ''}
${params.invoiceUrl ? `View invoice: ${params.invoiceUrl}` : ''}
${params.pdfAttachment ? 'A PDF copy of your receipt is attached to this email.' : ''}

— ${company}
  `.trim()

  if (params.tenantId) {
    const emailSecrets = await getIntegrationSecrets(params.tenantId, 'email')
    if (!emailSecrets) {
      throw new Error('Email is not configured. Set up email in Settings > Integrations.')
    }

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: params.to,
      subject,
      html,
      text,
      attachments: params.pdfAttachment
        ? [
            {
              filename: params.pdfFilename || `receipt-${params.invoiceNumber}.pdf`,
              content: params.pdfAttachment,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    })

    if (!sendResult.success) {
      throw new Error(sendResult.message || sendResult.error || 'Failed to send receipt email')
    }
    return
  }

  const emailService = new EmailService()
  await emailService.sendEmail({
    to: params.to,
    subject,
    html,
    text,
  })
}
