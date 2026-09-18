/**
 * Email Provider Integration
 * Supports SendGrid, Mailgun, Resend, Google (Gmail SMTP)
 */

import { IntegrationTestResult } from '../types'
import { mergeConfiguredGlobalCc } from '@/lib/email/recipients'

export interface EmailAttachment {
  filename: string
  content: Buffer | string   // Buffer for binary (PDF), string for base64/text
  contentType?: string
}

export interface SendEmailWithAttachmentsInput {
  secrets: Record<string, any>
  to: string | string[]
  subject: string
  html: string
  text?: string
  attachments?: EmailAttachment[]
  cc?: string[]
  /** Internal/staff alerts should not CC the global admin list. */
  skipGlobalCc?: boolean
}

/**
 * Send an email through the tenant's configured provider, with optional attachments.
 * Mirrors testEmailProvider but adds full attachment support.
 */
export async function sendEmailWithAttachments(
  input: SendEmailWithAttachmentsInput
): Promise<IntegrationTestResult> {
  const { secrets, to, subject, html, text, attachments } = input
  const recipients = mergeConfiguredGlobalCc({
    to,
    cc: input.cc,
    skipGlobalCc: Boolean(input.skipGlobalCc),
  })
  const normalizedTo = recipients.to
  const cc = recipients.cc

  console.info('email.send', {
    emailType: 'provider-with-attachments',
    sendSource: 'lib/integrations/providers/email.sendEmailWithAttachments',
    toCount: recipients.to.length,
    ccCount: cc.length,
    cc,
    globalCcCount: recipients.globalCc.length,
    skipGlobalCc: Boolean(input.skipGlobalCc),
  })

  try {
    const provider = secrets.provider || 'resend'
    switch (provider) {
      case 'sendgrid':
        return await sendViaSendGrid({ secrets, to: normalizedTo, subject, html, text, attachments, cc })
      case 'mailgun':
        return await sendViaMailgun({ secrets, to: normalizedTo, subject, html, text, attachments, cc })
      case 'google':
        return await sendViaGoogle({ secrets, to: normalizedTo, subject, html, text, attachments, cc })
      case 'resend':
      default:
        return await sendViaResend({ secrets, to: normalizedTo, subject, html, text, attachments, cc })
    }
  } catch (error: any) {
    return { success: false, message: 'Email send failed', error: error.message || 'Unknown error' }
  }
}

function toBase64(content: Buffer | string) {
  return Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content).toString('base64')
}

type ProviderSendInput = Omit<SendEmailWithAttachmentsInput, 'secrets' | 'to'> & {
  secrets: Record<string, any>
  to: string[]
}

async function sendViaSendGrid(input: ProviderSendInput): Promise<IntegrationTestResult> {
  const { secrets, to, subject, html, text, attachments, cc } = input
  const apiKey = secrets.apiKey
  if (!apiKey) return { success: false, message: 'SendGrid API key not configured', error: 'Missing apiKey' }

  const fromName = getFromName(secrets)
  const fromEmail = getFromEmail(secrets, 'noreply@trimpro.com')

  const personalization: Record<string, any> = { to: to.map((email) => ({ email })) }
  if (cc?.length) personalization.cc = cc.map((email) => ({ email }))

  const body: Record<string, any> = {
    personalizations: [personalization],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [{ type: 'text/html', value: html }],
  }
  if (text) body.content.unshift({ type: 'text/plain', value: text })
  if (attachments?.length) {
    body.attachments = attachments.map((a) => ({
      content: toBase64(a.content),
      filename: a.filename,
      type: a.contentType || 'application/octet-stream',
      disposition: 'attachment',
    }))
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.text()
    return { success: false, message: 'SendGrid send failed', error: `${response.status} - ${err}` }
  }
  return { success: true, message: `Email sent to ${to.join(', ')} via SendGrid` }
}

async function sendViaMailgun(input: ProviderSendInput): Promise<IntegrationTestResult> {
  const { secrets, to, subject, html, text, attachments, cc } = input
  const apiKey = secrets.apiKey
  const domain = secrets.mailgunDomain
  if (!apiKey || !domain) return { success: false, message: 'Mailgun not configured', error: 'Missing apiKey or domain' }

  const region = secrets.mailgunRegion || 'us'
  const apiBase = region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
  const fromName = getFromName(secrets)
  const fromEmail = getFromEmail(secrets, `noreply@${domain}`)

  const formData = new FormData()
  formData.append('from', formatFromHeader(fromName, fromEmail))
  to.forEach((recipient) => formData.append('to', recipient))
  if (cc?.length) cc.forEach((c) => formData.append('cc', c))
  formData.append('subject', subject)
  formData.append('html', html)
  if (text) formData.append('text', text)
  if (attachments?.length) {
    for (const att of attachments) {
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content)
      formData.append('attachment', new Blob([new Uint8Array(buf)], { type: att.contentType || 'application/octet-stream' }), att.filename)
    }
  }

  const response = await fetch(`${apiBase}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
    body: formData,
  })
  if (!response.ok) {
    const err = await response.text()
    return { success: false, message: 'Mailgun send failed', error: `${response.status} - ${err}` }
  }
  return { success: true, message: `Email sent to ${to.join(', ')} via Mailgun` }
}

async function sendViaResend(input: ProviderSendInput): Promise<IntegrationTestResult> {
  const { secrets, to, subject, html, text, attachments, cc } = input
  const apiKey = secrets.apiKey
  if (!apiKey) return { success: false, message: 'Resend API key not configured', error: 'Missing apiKey' }

  const fromName = getFromName(secrets)
  const fromEmail = getFromEmail(secrets, 'noreply@trimpro.com')

  const body: Record<string, any> = {
    from: formatFromHeader(fromName, fromEmail),
    to,
    subject,
    html,
  }
  if (cc?.length) body.cc = cc
  if (text) body.text = text
  if (attachments?.length) {
    body.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: toBase64(a.content),
    }))
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: response.statusText }))
    return { success: false, message: 'Resend send failed', error: (err as any).message || `${response.status}` }
  }
  return { success: true, message: `Email sent to ${to.join(', ')} via Resend` }
}

async function sendViaGoogle(input: ProviderSendInput): Promise<IntegrationTestResult> {
  const { secrets, to, subject, html, text, attachments, cc } = input
  const user = (secrets.googleEmail || secrets.fromEmail || '').trim()
  const pass = (secrets.googleAppPassword || '').trim()
  if (!user || !pass) return { success: false, message: 'Google credentials not configured', error: 'Missing credentials' }

  const nodemailer = await import('nodemailer')
  const fromName = getFromName(secrets)
  const fromEmail = getFromEmail(secrets, user)
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } })

  await transporter.sendMail({
    from: formatFromHeader(fromName, fromEmail),
    to: to.join(', '),
    cc: cc?.length ? cc.join(', ') : undefined,
    subject,
    html,
    text,
    attachments: attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
      contentType: a.contentType,
    })),
  })
  return { success: true, message: `Email sent to ${to.join(', ')} via Google` }
}

function getFromName(secrets: Record<string, any>) {
  return String(secrets.fromName || secrets.senderName || secrets.brandName || 'TrimPro').trim() || 'TrimPro'
}

function getFromEmail(secrets: Record<string, any>, fallback: string) {
  return String(secrets.fromEmail || secrets.emailFrom || secrets.senderEmail || fallback).trim() || fallback
}

function formatFromHeader(name: string, email: string) {
  // RFC 5322 friendly display-name format used by most providers.
  return `${name} <${email}>`
}

export async function testEmailProvider(
  secrets: Record<string, any>,
  to: string | string[],
  subject: string,
  html: string,
  options?: { skipAdminCc?: boolean }
): Promise<IntegrationTestResult> {
  const recipients = mergeConfiguredGlobalCc({ to, skipGlobalCc: options?.skipAdminCc })
  const normalizedTo = recipients.to
  const cc = recipients.cc

  console.info('email.send', {
    emailType: options?.skipAdminCc ? 'email-provider-test' : 'tenant-provider-email',
    sendSource: 'lib/integrations/providers/email.testEmailProvider',
    toCount: recipients.to.length,
    ccCount: cc.length,
    cc,
    globalCcCount: recipients.globalCc.length,
  })

  try {
    const provider = secrets.provider || 'resend'
    let result: any

    switch (provider) {
      case 'sendgrid':
        result = await testSendGrid(secrets, normalizedTo, subject, html, cc)
        break
      case 'mailgun':
        result = await testMailgun(secrets, normalizedTo, subject, html, cc)
        break
      case 'google':
        result = await testGoogle(secrets, normalizedTo, subject, html, cc)
        break
      case 'resend':
      default:
        result = await testResend(secrets, normalizedTo, subject, html, cc)
        break
    }

    return result
  } catch (error: any) {
    return {
      success: false,
      message: 'Email test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testSendGrid(
  secrets: Record<string, any>,
  to: string[],
  subject: string,
  html: string,
  cc?: string[]
): Promise<IntegrationTestResult> {
  const apiKey = secrets.apiKey
  if (!apiKey) {
    return { success: false, message: 'SendGrid API key not configured', error: 'Missing apiKey' }
  }

  try {
    const fromName = getFromName(secrets)
    const fromEmail = getFromEmail(secrets, 'noreply@trimpro.com')
    const personalization: Record<string, any> = { to: to.map((email) => ({ email })) }
    if (cc?.length) personalization.cc = cc.map((email) => ({ email }))
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [personalization],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [{ type: 'text/html', value: html }],
        reply_to: secrets.replyTo ? { email: secrets.replyTo } : undefined,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        message: 'SendGrid test failed',
        error: `SendGrid API error: ${response.status} - ${errorText}`,
      }
    }

    return {
      success: true,
      message: `Test email sent successfully to ${to.join(', ')} via SendGrid`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'SendGrid test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testMailgun(
  secrets: Record<string, any>,
  to: string[],
  subject: string,
  html: string,
  cc?: string[]
): Promise<IntegrationTestResult> {
  const apiKey = secrets.apiKey
  const domain = secrets.mailgunDomain
  if (!apiKey || !domain) {
    return {
      success: false,
      message: 'Mailgun API key or domain not configured',
      error: 'Missing apiKey or mailgunDomain',
    }
  }

  const region = secrets.mailgunRegion || 'us'
  const apiBase = region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'

  try {
    const fromName = getFromName(secrets)
    const fromEmail = getFromEmail(secrets, `noreply@${domain}`)
    const formData = new URLSearchParams()
    formData.append('from', formatFromHeader(fromName, fromEmail))
    to.forEach((email) => formData.append('to', email))
    if (cc?.length) formData.append('cc', cc.join(','))
    formData.append('subject', subject)
    formData.append('html', html)
    if (secrets.replyTo) {
      formData.append('h:Reply-To', secrets.replyTo)
    }

    const response = await fetch(`${apiBase}/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        message: 'Mailgun test failed',
        error: `Mailgun API error: ${response.status} - ${errorText}`,
      }
    }

    return {
      success: true,
      message: `Test email sent successfully to ${to.join(', ')} via Mailgun`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Mailgun test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testResend(
  secrets: Record<string, any>,
  to: string[],
  subject: string,
  html: string,
  cc?: string[]
): Promise<IntegrationTestResult> {
  const apiKey = secrets.apiKey
  if (!apiKey) {
    return { success: false, message: 'Resend API key not configured', error: 'Missing apiKey' }
  }

  try {
    const fromName = getFromName(secrets)
    const fromEmail = getFromEmail(secrets, 'noreply@trimpro.com')
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: formatFromHeader(fromName, fromEmail),
        to,
        cc: cc?.length ? cc : undefined,
        subject,
        html,
        reply_to: secrets.replyTo,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      return {
        success: false,
        message: 'Resend test failed',
        error: error.message || `Resend API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      message: `Test email sent successfully to ${to.join(', ')} via Resend`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Resend test failed',
      error: error.message || 'Unknown error',
    }
  }
}

async function testGoogle(
  secrets: Record<string, any>,
  to: string[],
  subject: string,
  html: string,
  cc?: string[]
): Promise<IntegrationTestResult> {
  const user = (secrets.googleEmail || secrets.fromEmail || '').trim()
  const pass = (secrets.googleAppPassword || '').trim()

  if (!user || !pass) {
    return {
      success: false,
      message: 'Google email credentials not configured',
      error: 'Missing googleEmail or googleAppPassword',
    }
  }

  try {
    const nodemailer = await import('nodemailer')
    const fromName = getFromName(secrets)
    const fromEmail = getFromEmail(secrets, user)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user,
        pass,
      },
    })

    await transporter.sendMail({
      from: formatFromHeader(fromName, fromEmail),
      to: to.join(', '),
      cc: cc?.length ? cc.join(', ') : undefined,
      subject,
      html,
      replyTo: secrets.replyTo || undefined,
    })

    return {
      success: true,
      message: `Test email sent successfully to ${to.join(', ')} via Google`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Google email test failed',
      error: error.message || 'Unknown error',
    }
  }
}
