import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

function money(n: any): string {
  const num = Number(n)
  if (!Number.isFinite(num)) return '$0.00'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
}

export default async function PublicQboAchPayPage({
  params,
}: {
  params: { publicToken: string }
}) {
  const token = String(params.publicToken || '').trim()
  if (!token) notFound()

  const intent = await prisma.invoicePaymentIntent.findFirst({
    where: { publicToken: token, provider: 'qbo', method: 'ach' },
    include: {
      invoice: {
        include: {
          client: { select: { name: true } },
          tenant: { select: { name: true } },
        },
      },
    },
  })

  if (!intent || !intent.invoice) notFound()

  const inv = intent.invoice
  const canPay = Boolean(intent.hostedUrl) && Number(inv.balance) > 0 && intent.status !== 'SUCCEEDED'

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-gray-500">{inv.tenant?.name || 'TrimPro'}</div>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Pay Invoice</h1>
            <div className="mt-1 text-sm text-gray-600">
              {inv.invoiceNumber} • {inv.title}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-500">Balance Due</div>
            <div className="text-2xl font-bold text-gray-900">{money(inv.balance)}</div>
          </div>
        </div>

        <div className="mt-6 rounded-xl border bg-gray-50 p-4">
          <div className="text-sm text-gray-600">Customer</div>
          <div className="font-semibold text-gray-900">{inv.client?.name || 'Customer'}</div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-gray-600">Invoice Total</div>
              <div className="font-semibold text-gray-900">{money(inv.total)}</div>
            </div>
            <div>
              <div className="text-gray-600">Status</div>
              <div className="font-semibold text-gray-900">{inv.status}</div>
            </div>
          </div>
        </div>

        <div className="mt-6">
          {!intent.hostedUrl && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              This invoice is not ready for ACH payment yet. Please contact the office.
            </div>
          )}

          {intent.status === 'SUCCEEDED' && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              Payment received. Thank you!
            </div>
          )}

          {canPay && (
            <a
              href={intent.hostedUrl!}
              className="mt-2 inline-flex w-full items-center justify-center rounded-lg bg-[#333333] px-4 py-3 text-sm font-semibold text-white hover:bg-[#3b3b3b]"
              rel="noopener noreferrer"
              target="_blank"
            >
              Pay with ACH (QuickBooks)
            </a>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between text-xs text-gray-500">
          <span>Powered by QuickBooks Payments</span>
          <span className="flex items-center gap-3">
            <Link className="hover:underline" href="/privacy">
              Privacy
            </Link>
            <Link className="hover:underline" href="/terms">
              Terms
            </Link>
          </span>
        </div>
      </div>
    </div>
  )
}

