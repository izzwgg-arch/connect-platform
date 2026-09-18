import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { sendEmailWithAttachments } from '@/lib/integrations/providers/email'
import { getEmailBranding } from '@/lib/email/branding'

export const runtime = 'nodejs'

// Maps a report key to the API route that already renders it (?format=pdf) —
// reuses each report's existing PDF generation instead of duplicating it here.
const REPORT_ROUTES: Record<string, { path: string; label: string; requiresClientId?: boolean }> = {
  revenue: { path: '/api/reports/revenue', label: 'Revenue by Month' },
  aging: { path: '/api/reports/aging', label: 'Invoices Aging' },
  'job-profitability': { path: '/api/reports/job-profitability', label: 'Job Profitability' },
  'vendor-spend': { path: '/api/reports/vendor-spend', label: 'Vendor Spend' },
  'customer-statement': { path: '/api/reports/customer-statement', label: 'Customer Statement', requiresClientId: true },
  payments: { path: '/api/payments/history', label: 'Payment History' },
}

const bodySchema = z.object({
  report: z.enum(['revenue', 'aging', 'job-profitability', 'vendor-spend', 'customer-statement', 'payments']),
  params: z.record(z.string()).optional(),
  recipients: z.array(z.string().trim().email()).min(1, 'Enter at least one recipient email address.'),
  message: z.string().trim().max(2000).optional(),
})

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'reports.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
    }
    const { report, params, recipients, message } = parsed.data
    const meta = REPORT_ROUTES[report]
    if (meta.requiresClientId && !params?.clientId) {
      return NextResponse.json({ error: 'Select a customer before emailing this report.' }, { status: 400 })
    }

    const search = new URLSearchParams(params || {})
    search.set('format', 'pdf')
    const authHeader = request.headers.get('authorization') || ''
    // Call the report route over the internal loopback, not the public HTTPS
    // origin — fetching our own public domain from inside the server round-trips
    // through the reverse proxy/TLS termination and can fail there (seen in
    // production as an SSL "packet length too long" error). The app always
    // listens on this port internally (see the `next start -p 3000` process).
    const internalBase = process.env.INTERNAL_APP_URL || 'http://127.0.0.1:3000'
    const pdfRes = await fetch(`${internalBase}${meta.path}?${search.toString()}`, {
      headers: { Authorization: authHeader },
    })
    if (!pdfRes.ok) {
      console.error('Report email: PDF generation failed', report, pdfRes.status)
      return NextResponse.json({ error: 'Failed to generate the report PDF.' }, { status: 502 })
    }
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())

    const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')
    if (!emailSecrets) {
      return NextResponse.json(
        { error: 'Email integration is not configured. Please configure Email Provider first.' },
        { status: 400 }
      )
    }

    const emailBranding = await getEmailBranding(user.tenantId)
    const companyName =
      (emailBranding as { businessName?: string; companyName?: string } | null)?.businessName ||
      (emailBranding as { companyName?: string } | null)?.companyName ||
      'TrimPro'
    const dateLabel = new Date().toISOString().split('T')[0]
    const filename = `${report}-report-${dateLabel}.pdf`
    const subject = `${meta.label} Report`

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 12px;color:#111827;">${escapeHtml(meta.label)} Report</h2>
        ${message ? `<p style="color:#374151;white-space:pre-wrap;">${escapeHtml(message)}</p>` : ''}
        <p style="color:#6b7280;font-size:14px;">The report is attached as a PDF.</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Sent from ${escapeHtml(companyName)}</p>
      </div>
    `
    const text = `${meta.label} Report\n\n${message || 'Please see the attached report.'}\n\nSent from ${companyName}`

    const sendResult = await sendEmailWithAttachments({
      secrets: emailSecrets,
      to: recipients,
      subject,
      html,
      text,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    })
    if (!sendResult.success) {
      console.error('Report email send failed:', sendResult.error || sendResult.message)
      return NextResponse.json(
        { error: sendResult.error || sendResult.message || 'Failed to send report email' },
        { status: 502 }
      )
    }

    await prisma.email.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        direction: 'OUTBOUND',
        status: 'SENT',
        subject,
        body: message || `Please find attached the ${meta.label} report.`,
        fromEmail: user.email,
        toEmails: recipients,
        clientId: params?.clientId || null,
        sentAt: new Date(),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Report email error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
