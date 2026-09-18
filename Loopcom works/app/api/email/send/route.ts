import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { sendEmail, sendBulkEmails, resolveTemplateVariables } from '@/lib/email/provider'
import { z } from 'zod'

const sendEmailSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email())]),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string()).optional(),
  clientId: z.string().optional(),
  jobId: z.string().optional(),
  leadId: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['messaging.email', 'messages.send'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const data = sendEmailSchema.parse(body)

    let subject = data.subject
    let html = data.html
    let text = data.text

    // Resolve template if provided
    if (data.templateId) {
      const template = await prisma.emailTemplate.findFirst({
        where: {
          id: data.templateId,
          tenantId: user.tenantId,
          isActive: true,
        },
      })

      if (!template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      const variables = data.variables || {}
      subject = resolveTemplateVariables(template.subject, variables)
      html = resolveTemplateVariables(template.body, variables)
      text = html?.replace(/<[^>]*>/g, '') // Strip HTML for text version
    }

    // Prepare email addresses
    const toArray = Array.isArray(data.to) ? data.to : [data.to]
    const fromEmail = process.env.EMAIL_FROM || 'noreply@trimpro.com'
    const replyTo = process.env.EMAIL_REPLY_TO || fromEmail

    // Send email via provider
    const sendResult = await sendEmail({
      to: toArray,
      subject,
      html,
      text,
      from: fromEmail,
      replyTo,
      metadata: {
        clientId: data.clientId,
        jobId: data.jobId,
        leadId: data.leadId,
      },
    })

    if (!sendResult.success) {
      return NextResponse.json(
        { error: sendResult.error || 'Failed to send email' },
        { status: 500 }
      )
    }

    // Store email in database
    const email = await prisma.email.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        direction: 'OUTBOUND',
        status: sendResult.success ? 'SENT' : 'FAILED',
        subject,
        body: text || '',
        bodyHtml: html || null,
        fromEmail,
        toEmails: toArray,
        ccEmails: [],
        bccEmails: [],
        replyTo,
        providerId: sendResult.messageId || null,
        providerData: sendResult,
        clientId: data.clientId || null,
        jobId: data.jobId || null,
        leadId: data.leadId || null,
        sentAt: sendResult.success ? new Date() : null,
      },
    })

    return NextResponse.json({ email, success: true }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    console.error('Send email error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
