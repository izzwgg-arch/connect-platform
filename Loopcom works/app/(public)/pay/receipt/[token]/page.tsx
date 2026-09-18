import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadPaymentReceiptContextByToken } from '@/lib/payments/receipts'

export const dynamic = 'force-dynamic'

export default async function PublicPaymentReceiptPage({
  params,
}: {
  params: { token: string }
}) {
  const token = String(params.token || '').trim()
  if (!token) notFound()

  const ctx = await loadPaymentReceiptContextByToken(token)
  if (!ctx) notFound()

  const htmlUrl = `/api/public/payments/receipt/${encodeURIComponent(token)}?format=html`
  const pdfDownloadUrl = `/api/public/payments/receipt/${encodeURIComponent(token)}?format=pdf&download=1`

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Payment Receipt</h1>
            <p className="text-sm text-slate-600">
              Invoice {ctx.invoice.invoiceNumber} · {ctx.tenantName}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={pdfDownloadUrl}
              className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Download PDF
            </a>
            <Link
              href={(() => {
                try {
                  const url = new URL(ctx.invoiceUrl)
                  return `${url.pathname}${url.search}`
                } catch {
                  return `/portal/pay/${ctx.invoice.id}`
                }
              })()}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              View invoice
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-6">
        <iframe
          src={htmlUrl}
          title={`Payment receipt for invoice ${ctx.invoice.invoiceNumber}`}
          className="h-[min(900px,calc(100vh-120px))] w-full rounded-xl border border-slate-200 bg-white shadow-sm"
        />
      </div>
    </div>
  )
}
