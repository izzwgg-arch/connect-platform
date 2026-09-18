import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildCreditMemoPdfHtml } from '@/lib/documents/pdf-templates'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const shouldPrint = request.nextUrl.searchParams.get('print') === '1'
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1'
    const format = request.nextUrl.searchParams.get('format') || 'pdf'
    const wantsHtml = format === 'html'
    const brand = await getPdfBranding(user.tenantId)

    const creditMemo = await prisma.creditMemo.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            companyName: true,
            email: true,
            phone: true,
          },
        },
        job: { select: { id: true, jobNumber: true, title: true } },
        sourceInvoice: { select: { id: true, invoiceNumber: true } },
        lineItems: { orderBy: { sortOrder: 'asc' } },
      },
    })

    if (!creditMemo) {
      return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 })
    }

    const html = buildCreditMemoPdfHtml(creditMemo, brand, { shouldPrint })

    if (wantsHtml) {
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="CM-${creditMemo.creditMemoNumber}.html"`,
        },
      })
    }

    try {
      const pdf = await renderPdfFromHtml(html)
      return new NextResponse(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="CM-${creditMemo.creditMemoNumber}.pdf"`,
        },
      })
    } catch (e) {
      console.error('Credit memo PDF render failed; falling back to HTML:', e)
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="CM-${creditMemo.creditMemoNumber}.html"`,
        },
      })
    }
  } catch (error) {
    console.error('Generate credit memo PDF error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
