import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildInvoicePdfHtml } from '@/lib/documents/pdf-templates'
import { parseInvoicePdfView } from '@/lib/invoices/invoice-pdf-view'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const format = request.nextUrl.searchParams.get('format') || 'pdf'
    const wantsHtml = format === 'html'
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1'
    const shouldPrint = request.nextUrl.searchParams.get('print') === '1'
    const view = parseInvoicePdfView(request.nextUrl.searchParams.get('view'))
    const token = request.nextUrl.searchParams.get('token') || ''
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        paymentToken: token,
      },
      include: {
        client: {
          include: {
            contacts: {
              where: { isPrimary: true },
              take: 1,
            },
          },
        },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
            addresses: {
              where: { type: 'job_site' },
              take: 1,
            },
          },
        },
        estimate: {
          select: {
            jobSiteAddress: true,
          },
        },
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const brand = await getPdfBranding(invoice.tenantId)
    const viewSuffix = view === 'company' ? '-company' : '-customer'
    const html = buildInvoicePdfHtml(invoice, brand, { shouldPrint, view })

    if (wantsHtml) {
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Invoice-${invoice.invoiceNumber}${viewSuffix}.html"`,
        },
      })
    }

    try {
      const pdf = await renderPdfFromHtml(html)
      return new NextResponse(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Invoice-${invoice.invoiceNumber}${viewSuffix}.pdf"`,
        },
      })
    } catch (e) {
      console.error('Public invoice PDF render failed; falling back to HTML:', e)
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Invoice-${invoice.invoiceNumber}${viewSuffix}.html"`,
        },
      })
    }
  } catch (error) {
    console.error('Public invoice PDF error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
