import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashApprovalToken } from '@/lib/estimate-approval'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { rateLimitOrThrow } from '@/lib/security/rate-limit'
import { buildEstimatePdfHtml } from '@/lib/documents/pdf-templates'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    rateLimitOrThrow(request, { key: 'public-estimate-pdf-by-token:get', limit: 30, windowMs: 60_000 })

    const rawToken = String(params.token || '').trim()
    if (rawToken.length < 20) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const tokenHash = hashApprovalToken(rawToken)
    const now = new Date()
    const tokenRow = await prisma.estimateApprovalToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { tenantId: true, estimateId: true },
    })

    if (!tokenRow) {
      return NextResponse.json({ error: 'Link is invalid or expired.' }, { status: 404 })
    }

    const estimate = await prisma.estimate.findFirst({
      where: { id: tokenRow.estimateId, tenantId: tokenRow.tenantId },
      include: {
        client: true,
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: { group: true },
        },
        optionalItems: { orderBy: { sortOrder: 'asc' } },
      },
    })

    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const itemApprovals = await prisma.estimateItemApproval.findMany({
      where: { estimateId: estimate.id, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedIdSet = new Set(itemApprovals.map((a) => a.estimateLineItemId))

    const brand = await getPdfBranding(estimate.tenantId)
    // Public customer downloads always use the customer bundled estimate.
    const html = buildEstimatePdfHtml(estimate, brand, approvedIdSet, {
      view: 'customer',
    })

    try {
      const pdf = await renderPdfFromHtml(html)
      return new NextResponse(pdf, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="Estimate-${estimate.estimateNumber}-customer.pdf"`,
        },
      })
    } catch (e) {
      console.error('Token-based estimate PDF render failed; falling back to HTML:', e)
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }
  } catch (err: any) {
    if (err instanceof NextResponse) return err
    if (err?.status === 429) return err
    console.error('Public estimate PDF by-token error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
