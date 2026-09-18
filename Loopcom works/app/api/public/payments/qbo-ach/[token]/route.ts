import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const token = String(params.token || '').trim()
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

  const intent = await prisma.invoicePaymentIntent.findFirst({
    where: { publicToken: token, provider: 'qbo', method: 'ach' },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          title: true,
          total: true,
          balance: true,
          status: true,
          tenantId: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  if (!intent || !intent.invoice) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (intent.expiresAt && intent.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Link expired' }, { status: 410 })
  }

  return NextResponse.json({
    intent: {
      id: intent.id,
      status: intent.status,
      hostedUrl: intent.hostedUrl,
      provider: intent.provider,
      method: intent.method,
    },
    invoice: intent.invoice,
  })
}

