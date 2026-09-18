'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'

interface EstimateItem {
  id: string
  description: string
  notes: string
  quantity: string
  unitPrice: string
  total: string
  showPriceToCustomer: boolean
  isOptional: boolean
  isSubtotal: boolean
  approved: boolean
}

interface EstimateData {
  id: string
  estimateNumber: string
  title: string
  jobSiteAddress: string | null
  client: { name: string } | null
}

function toCurrency(value: string | number) {
  const n = typeof value === 'number' ? value : Number(value || 0)
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function EstimateViewPage() {
  const params = useParams()
  const token = String((params as any)?.token || '')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<EstimateData | null>(null)
  const [viewMode, setViewMode] = useState<'customer' | 'company'>('customer')
  const [items, setItems] = useState<EstimateItem[]>([])
  const [optionalItems, setOptionalItems] = useState<EstimateItem[]>([])

  useEffect(() => {
    if (!token) return
    const load = async () => {
      try {
        const res = await fetch(`/api/public/estimate-approval/${encodeURIComponent(token)}`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setError(data?.error || 'Unable to load estimate.'); return }
        setEstimate(data.estimate)
        setViewMode(data.viewMode === 'company' ? 'company' : 'customer')
        setItems(data.items || [])
        setOptionalItems(data.optionalItems || [])
      } catch {
        setError('Unable to load estimate.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [token])

  const isCustomerView = viewMode === 'customer'

  const grandTotal = useMemo(() => {
    const allItems = [...items, ...optionalItems]
    return allItems.filter((i) => !i.isSubtotal).reduce((sum, i) => sum + Number(i.total || 0), 0)
  }, [items, optionalItems])

  const regularTotal = useMemo(
    () => items.filter((i) => !i.isSubtotal).reduce((sum, i) => sum + Number(i.total || 0), 0),
    [items]
  )

  const pdfUrl = `/api/public/estimates/by-token/${encodeURIComponent(token)}/pdf`
  const approveUrl = `/approve/estimate/${encodeURIComponent(token)}`

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600" />
          <p className="text-sm text-slate-500">Loading estimate...</p>
        </div>
      </div>
    )
  }

  if (error || !estimate) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm max-w-sm w-full">
          <p className="text-2xl mb-2">!</p>
          <p className="text-sm text-red-600">{error || 'Estimate not found.'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-lg px-4 pb-16 pt-6">

        {/* Header */}
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Estimate</p>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            {estimate.title || `Estimate ${estimate.estimateNumber}`}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-slate-500">
            {estimate.client?.name && <span>{estimate.client.name}</span>}
            <span className="text-slate-300">·</span>
            <span>{estimate.estimateNumber}</span>
            {estimate.jobSiteAddress && (
              <>
                <span className="text-slate-300">·</span>
                <span>{estimate.jobSiteAddress}</span>
              </>
            )}
          </div>
        </div>

        {/* Total hero */}
        <div className="mb-4 rounded-2xl px-6 py-6 text-center" style={{ background: '#243f53' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#8cb4cf' }}>
            Total Amount
          </p>
          <p className="mt-2 text-5xl font-extrabold tracking-tight text-white">
            {toCurrency(regularTotal)}
          </p>
          {optionalItems.length > 0 && (
            <p className="mt-2 text-xs" style={{ color: '#8cb4cf' }}>
              + optional add-ons available below
            </p>
          )}
        </div>

        {/* Line items */}
        <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="px-5 py-4 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-900">Estimate Details</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {items.filter((i) => !i.isSubtotal).length} item{items.filter((i) => !i.isSubtotal).length === 1 ? '' : 's'}
            </p>
          </div>

          {/* Mobile card view */}
          <div className="md:hidden divide-y divide-slate-100 px-4 py-2">
            {items.map((item) => {
              if (item.isSubtotal) {
                return (
                  <div key={item.id} className="flex justify-between py-3 font-semibold text-sm text-slate-800">
                    <span>Subtotal</span>
                    <span>{toCurrency(item.total)}</span>
                  </div>
                )
              }
              return (
                <div key={item.id} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900 leading-snug whitespace-pre-wrap break-words">{item.description}</p>
                    <p className="shrink-0 text-sm font-bold text-slate-900">{toCurrency(item.total)}</p>
                  </div>
                  {item.showPriceToCustomer && !isCustomerView && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Qty {item.quantity} × {toCurrency(item.unitPrice)}
                    </p>
                  )}
                  {item.notes && (
                    <p className="mt-1 text-xs text-slate-400 italic whitespace-pre-wrap break-words">{item.notes}</p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="px-4 py-3 text-left font-medium text-slate-500">
                    {isCustomerView ? 'Line' : 'Description'}
                  </th>
                  {!isCustomerView && (
                    <>
                      <th className="px-4 py-3 text-right font-medium text-slate-500">Qty</th>
                      <th className="px-4 py-3 text-right font-medium text-slate-500">Unit</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-right font-medium text-slate-500">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) =>
                  item.isSubtotal ? (
                    <tr key={item.id} className="bg-slate-50 font-semibold">
                      <td
                        colSpan={isCustomerView ? 1 : 3}
                        className="px-4 py-3 text-right text-slate-700"
                      >
                        Subtotal
                      </td>
                      <td className="px-4 py-3 text-right text-slate-900">{toCurrency(item.total)}</td>
                    </tr>
                  ) : (
                    <tr key={item.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 whitespace-pre-wrap break-words">
                          {item.description}
                        </div>
                        {item.notes && (
                          <div className="text-xs text-slate-400 italic mt-0.5 whitespace-pre-wrap break-words">
                            {item.notes}
                          </div>
                        )}
                      </td>
                      {!isCustomerView && (
                        <>
                          <td className="px-4 py-3 text-right text-slate-600">{item.quantity}</td>
                          <td className="px-4 py-3 text-right text-slate-600">
                            {item.showPriceToCustomer ? toCurrency(item.unitPrice) : '—'}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right font-semibold text-slate-900">
                        {toCurrency(item.total)}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          {/* Totals summary */}
          <div className="border-t border-slate-100 px-5 py-4 space-y-2">
            <div className="flex justify-between text-sm font-bold text-slate-900">
              <span>Total</span>
              <span>{toCurrency(regularTotal)}</span>
            </div>
          </div>
        </div>

        {/* Optional items */}
        {optionalItems.length > 0 && (
          <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm">
            <div className="px-5 py-4 border-b border-amber-100 bg-amber-50">
              <p className="text-sm font-semibold text-amber-900">Optional Add-ons</p>
              <p className="mt-0.5 text-xs text-amber-700">
                These items are available to add — approve the estimate to include them
              </p>
            </div>
            <div className="md:hidden divide-y divide-slate-100 px-4 py-2">
              {optionalItems.map((item) => (
                <div key={item.id} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900 whitespace-pre-wrap break-words">{item.description}</p>
                    <p className="shrink-0 text-sm font-bold text-slate-900">{toCurrency(item.total)}</p>
                  </div>
                  {item.showPriceToCustomer && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Qty {item.quantity} × {toCurrency(item.unitPrice)}
                    </p>
                  )}
                  {item.notes && <p className="mt-1 text-xs text-slate-400 italic whitespace-pre-wrap break-words">{item.notes}</p>}
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-amber-50">
                    <th className="px-4 py-3 text-left font-medium text-amber-700">Description</th>
                    <th className="px-4 py-3 text-right font-medium text-amber-700">Qty</th>
                    <th className="px-4 py-3 text-right font-medium text-amber-700">Unit</th>
                    <th className="px-4 py-3 text-right font-medium text-amber-700">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {optionalItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 whitespace-pre-wrap break-words">{item.description}</div>
                        {item.notes && <div className="text-xs text-slate-400 italic mt-0.5 whitespace-pre-wrap break-words">{item.notes}</div>}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600">{item.quantity}</td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {item.showPriceToCustomer ? toCurrency(item.unitPrice) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-900">{toCurrency(item.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {optionalItems.length > 0 && (
              <div className="border-t border-slate-100 px-5 py-3">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Optional subtotal</span>
                  <span className="font-medium">
                    {toCurrency(optionalItems.reduce((s, i) => s + Number(i.total || 0), 0))}
                  </span>
                </div>
                <div className="flex justify-between text-sm font-bold text-slate-900 mt-1">
                  <span>Grand total (if all added)</span>
                  <span>{toCurrency(grandTotal)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <a
            href={approveUrl}
            className="block w-full rounded-2xl py-4 text-center text-sm font-bold text-white transition hover:brightness-110"
            style={{ background: 'linear-gradient(135deg, #1e4d6e 0%, #c9a84c 100%)' }}
          >
            Approve Estimate
          </a>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-2xl border border-slate-200 bg-white py-3.5 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Download PDF
          </a>
        </div>

        <p className="mt-8 text-center text-xs text-slate-400">
          Questions? Reply to the email this estimate was sent from.
        </p>
      </div>
    </div>
  )
}
