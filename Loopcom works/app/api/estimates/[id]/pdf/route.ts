import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireWebOrMobilePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildEstimatePdfHtml } from '@/lib/documents/pdf-templates'
import { parseEstimatePdfView } from '@/lib/estimates/estimate-pdf-view'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrMobilePermission(
    request,
    'estimates.view',
    'mobile.jobs.view_documents'
  )
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const shouldPrint = request.nextUrl.searchParams.get('print') === '1'
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1'
    const format = request.nextUrl.searchParams.get('format') || 'pdf'
    const view = parseEstimatePdfView(request.nextUrl.searchParams.get('view'))
    const wantsHtml = format === 'html'
    const brand = await getPdfBranding(user.tenantId)

    const estimate = await prisma.estimate.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
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
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const itemApprovals = await prisma.estimateItemApproval.findMany({
      where: { estimateId: estimate.id, tenantId: user.tenantId, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedIdSet = new Set(itemApprovals.map((a) => a.estimateLineItemId))

    const viewSuffix = view === 'company' ? '-company' : '-customer'
    const html = buildEstimatePdfHtml(estimate, brand, approvedIdSet, { shouldPrint, view })

    if (wantsHtml) {
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Estimate-${estimate.estimateNumber}${viewSuffix}.html"`,
        },
      })
    }

    try {
      const pdf = await renderPdfFromHtml(html)
      return new NextResponse(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Estimate-${estimate.estimateNumber}${viewSuffix}.pdf"`,
        },
      })
    } catch (e) {
      console.error('PDF render failed; falling back to HTML:', e)
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Estimate-${estimate.estimateNumber}${viewSuffix}.html"`,
        },
      })
    }
  } catch (error) {
    console.error('Generate estimate PDF error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
