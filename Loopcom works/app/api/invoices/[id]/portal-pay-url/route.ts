import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function resolvePortalBaseUrl(request: NextRequest) {
  const origin = String(request.headers.get('origin') || '').trim()
  if (origin) return origin.replace(/\/+$/, '')

  const forwardedHost = String(request.headers.get('x-forwarded-host') || '').trim()
  const forwardedProto = String(request.headers.get('x-forwarded-proto') || 'https').trim()
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '')

  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
  ]) {
    const value = String(candidate || '').trim()
    if (value) return value.replace(/\/+$/, '')
  }

  return 'http://localhost:3001'
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'invoices.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        paymentToken: true,
        balance: true,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (Number(invoice.balance) <= 0) {
      return NextResponse.json({ error: 'Invoice is already paid' }, { status: 400 })
    }

    let paymentToken = invoice.paymentToken
    if (!paymentToken) {
      paymentToken = randomBytes(20).toString('hex')
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { paymentToken },
      })
    }

    const baseUrl = resolvePortalBaseUrl(request)
    const portalUrl = `${baseUrl}/portal/pay/${invoice.id}?token=${encodeURIComponent(paymentToken)}&invoices=1`

    return NextResponse.json({ portalUrl, paymentToken })
  } catch (error) {
    console.error('Portal pay URL error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
