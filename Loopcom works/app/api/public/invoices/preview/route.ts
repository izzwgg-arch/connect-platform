import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * Public endpoint: fetch invoice preview for another invoice belonging to the same client,
 * using a payment token as proof-of-access.
 *
 * Query params:
 * - token: paymentToken from email link
 * - id: target invoice id to preview
 */
export async function GET(request: NextRequest) {
  try {
    const token = String(request.nextUrl.searchParams.get('token') || '').trim()
    const targetId = String(request.nextUrl.searchParams.get('id') || '').trim()
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    if (!targetId) return NextResponse.json({ error: 'Missing invoice id' }, { status: 400 })

    const authInvoice = await prisma.invoice.findFirst({
      where: { paymentToken: token },
      select: { tenantId: true, clientId: true },
    })
    if (!authInvoice) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: targetId,
        tenantId: authInvoice.tenantId,
        clientId: authInvoice.clientId,
      },
      include: {
        client: true,
        lineItems: { orderBy: { sortOrder: 'asc' } },
      },
    })

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        title: invoice.title,
        status: invoice.status,
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        total: invoice.total.toString(),
        balance: invoice.balance.toString(),
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        client: {
          name: invoice.client.name,
          companyName: invoice.client.companyName,
        },
        lineItems: invoice.lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity.toString(),
          unitPrice: li.unitPrice.toString(),
          total: li.total.toString(),
        })),
      },
    })
  } catch (error) {
    console.error('Public invoice preview error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

