'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

type ReturnStatusResponse = {
  finalState: 'pending' | 'confirmed' | 'failed'
  intentStatus: string
  invoice: {
    id: string
    invoiceNumber: string
    status: string
    total: number
    balance: number
  }
  payment: {
    id: string
    amount: number
    processedAt: string | null
    providerPaymentId: string | null
    receiptEmailSentAt: string | null
    receiptUrl: string | null
  } | null
}

export default function QuickBooksPaymentReturnPage() {
  const searchParams = useSearchParams()
  const attempt = String(searchParams.get('attempt') || '').trim()
  const result = String(searchParams.get('result') || '').trim()

  const [data, setData] = useState<ReturnStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!attempt) {
      setError('Missing payment attempt token.')
      setPolling(false)
      return
    }

    let mounted = true
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const response = await fetch(`/api/public/payments/quickbooks/return-status?attempt=${encodeURIComponent(attempt)}`)
        const payload = await response.json().catch(() => ({}))
        if (!mounted) return
        if (!response.ok) {
          setError(payload.error || 'Unable to verify payment status.')
          setPolling(false)
          return
        }
        setData(payload as ReturnStatusResponse)
        if (payload.finalState === 'confirmed' || payload.finalState === 'failed') {
          setPolling(false)
          return
        }
        if (Date.now() - startedAt >= 30_000) {
          setPolling(false)
          return
        }
      } catch {
        if (!mounted) return
        if (Date.now() - startedAt >= 30_000) {
          setPolling(false)
          setError('Payment is still processing. Please check back shortly.')
          return
        }
      }
      timer = setTimeout(poll, 2500)
    }

    poll()

    return () => {
      mounted = false
      if (timer) clearTimeout(timer)
    }
  }, [attempt])

  const title = useMemo(() => {
    if (data?.finalState === 'confirmed') return 'Payment confirmed'
    if (data?.finalState === 'failed') return 'Payment not completed'
    if (result === 'cancel') return 'Payment cancelled'
    return 'Finalizing your payment'
  }, [data?.finalState, result])

  const subtitle = useMemo(() => {
    if (data?.finalState === 'confirmed') {
      return `Invoice ${data.invoice.invoiceNumber} has been updated.`
    }
    if (data?.finalState === 'failed' || result === 'cancel') {
      return 'No charge was confirmed by QuickBooks.'
    }
    return 'We are waiting for QuickBooks confirmation. This can take a few seconds.'
  }, [data, result])

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{subtitle}</p>

        {polling && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            Checking payment status...
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {data && (
          <div className="mt-5 space-y-2 text-sm">
            <div>
              <span className="text-gray-500">Invoice:</span> <span className="font-semibold">{data.invoice.invoiceNumber}</span>
            </div>
            <div>
              <span className="text-gray-500">Invoice status:</span> <span className="font-semibold">{data.invoice.status}</span>
            </div>
            {data.payment?.providerPaymentId && (
              <div>
                <span className="text-gray-500">QuickBooks payment ID:</span>{' '}
                <span className="font-semibold">{data.payment.providerPaymentId}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {data?.payment?.receiptUrl ? (
            <a
              href={data.payment.receiptUrl}
              className="inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-black"
            >
              View receipt
            </a>
          ) : null}
          {data?.invoice?.id ? (
            <Link
              href={`/portal/pay/${data.invoice.id}`}
              className="inline-flex items-center justify-center rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              View invoice
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  )
}
