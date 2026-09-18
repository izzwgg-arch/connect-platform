import { NextRequest, NextResponse } from 'next/server'
import {
  generatePaymentReceiptPdfByToken,
  getPaymentReceiptHtmlByToken,
} from '@/lib/payments/receipts'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const token = String(params.token || '').trim()
    if (!token) {
      return NextResponse.json({ error: 'Missing receipt token' }, { status: 400 })
    }

    const format = request.nextUrl.searchParams.get('format') || 'pdf'
    const wantsHtml = format === 'html'
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1'

    if (wantsHtml) {
      const result = await getPaymentReceiptHtmlByToken(token)
      if (!result) {
        return NextResponse.json({ error: 'Receipt not found or expired' }, { status: 404 })
      }

      return new NextResponse(result.html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    const result = await generatePaymentReceiptPdfByToken(token)
    if (!result) {
      return NextResponse.json({ error: 'Receipt not found or expired' }, { status: 404 })
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-store',
        'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="${result.filename}"`,
      },
    })
  } catch (error) {
    console.error('Public payment receipt error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
