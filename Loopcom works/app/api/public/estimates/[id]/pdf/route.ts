import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildEstimatePdfHtml } from '@/lib/documents/pdf-templates'

export const runtime = 'nodejs'

function getPublicLinkSecret(): string {
  const secret = String(process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || '').trim()
  if (!secret) throw new Error('ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required for public estimate PDF links')
  return secret
}

function timingSafeEqualHex(a: string, b: string) {
  const aa = Buffer.from(String(a || ''), 'hex')
  const bb = Buffer.from(String(b || ''), 'hex')
  if (aa.length !== bb.length) return false
  return crypto.timingSafeEqual(aa, bb)
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const format = request.nextUrl.searchParams.get('format') || 'pdf'
    const wantsHtml = format === 'html'
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1'
    const sentRaw = request.nextUrl.searchParams.get('sent') || ''
    const sig = request.nextUrl.searchParams.get('sig') || ''

    const sent = Number(sentRaw)
    if (!Number.isFinite(sent) || sent <= 0) {
      return NextResponse.json({ error: 'Missing sent timestamp' }, { status: 401 })
    }
    if (!sig) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
    }

    const maxAgeMs = 1000 * 60 * 60 * 24 * 365
    if (Math.abs(Date.now() - sent) > maxAgeMs) {
      return NextResponse.json({ error: 'Link expired' }, { status: 401 })
    }

    const secret = getPublicLinkSecret()
    const expected = crypto.createHmac('sha256', secret).update(`${params.id}.${sent}`).digest('hex')
    if (!timingSafeEqualHex(sig, expected)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const estimate = await prisma.estimate.findFirst({
      where: { id: params.id },
      include: {
        client: true,
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
      where: { estimateId: estimate.id, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedIdSet = new Set(itemApprovals.map((a) => a.estimateLineItemId))

    const brand = await getPdfBranding(estimate.tenantId)
    // Public customer downloads always use the customer bundled estimate.
    const html = buildEstimatePdfHtml(estimate, brand, approvedIdSet, {
      view: 'customer',
    })

    if (wantsHtml) {
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    try {
      const pdf = await renderPdfFromHtml(html)
      return new NextResponse(pdf, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Estimate-${estimate.estimateNumber}-customer.pdf"`,
        },
      })
    } catch (e) {
      console.error('Public PDF render failed; falling back to HTML:', e)
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="Estimate-${estimate.estimateNumber}-customer.html"`,
        },
      })
    }
  } catch (error) {
    console.error('Public estimate pdf error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
