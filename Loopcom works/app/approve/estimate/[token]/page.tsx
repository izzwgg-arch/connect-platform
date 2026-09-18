'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { formatCurrency } from '@/lib/utils'

type ApprovalItem = {
  id: string
  description: string
  notes: string
  quantity: string
  unitPrice: string
  total: string
  isOptional: boolean
  isCustomerBundle?: boolean
  isSubtotal?: boolean
  approved: boolean
  approvedAt: string | null
  approvedByName: string | null
  invoiced: boolean
  invoicedAt: string | null
}

export default function PublicEstimateApprovalPage() {
  const params = useParams()
  const token = String((params as any)?.token || '')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<any>(null)
  const [viewMode, setViewMode] = useState<'customer' | 'company'>('customer')
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [optionalItems, setOptionalItems] = useState<ApprovalItem[]>([])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [signerName, setSignerName] = useState('')
  const [eSign, setESign] = useState(false)
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const selectableRegularIds = useMemo(
    () => items.filter((i) => !i.approved && !i.isSubtotal).map((i) => i.id),
    [items]
  )
  const selectableOptionalIds = useMemo(
    () => optionalItems.filter((i) => !i.approved && !i.isSubtotal).map((i) => i.id),
    [optionalItems]
  )
  const allSelectableIds = useMemo(
    () => [...selectableRegularIds, ...selectableOptionalIds],
    [selectableRegularIds, selectableOptionalIds]
  )

  const selectedTotal = useMemo(() => {
    const allItems = [...items, ...optionalItems]
    const map = new Map(allItems.map((i) => [i.id, i]))
    let sum = 0
    for (const id of selectedIds) {
      const it = map.get(id)
      if (!it || it.isSubtotal) continue
      sum += Number(it.total || 0)
    }
    return sum
  }, [items, optionalItems, selectedIds])

  const pendingOptionalItems = useMemo(
    () => optionalItems.filter((i) => !i.approved),
    [optionalItems]
  )

  const isCustomerView = viewMode === 'customer'
  const pdfUrl = `/api/public/estimates/by-token/${encodeURIComponent(token)}/pdf`

  const refresh = async () => {
    setLoading(true)
    setLoadError(null)
    setActionError(null)
    setSuccessMsg(null)

    try {
      const res = await fetch(`/api/public/estimate-approval/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(data?.error || 'Unable to load estimate approval.')
        setEstimate(null)
        setItems([])
        setOptionalItems([])
        return
      }

      setEstimate(data.estimate)
      setViewMode(data.viewMode === 'company' ? 'company' : 'customer')
      setItems(data.items || [])
      setOptionalItems(data.optionalItems || [])

      setSelectedIds((prev) => {
        const allItems = [...(data.items || []), ...(data.optionalItems || [])]
        const selectable = allItems.filter((i: any) => !i.approved && !i.isSubtotal)
        const allowed = new Set(selectable.map((i: any) => i.id))
        if (prev.size === 0) {
          return new Set(selectable.map((i: any) => i.id))
        }
        const next = new Set<string>()
        for (const id of prev) {
          if (allowed.has(id)) next.add(id)
        }
        return next
      })
    } catch (e: any) {
      setLoadError(e?.message || 'Unable to load estimate approval.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelectedIds(new Set(allSelectableIds))
  const clearAll = () => setSelectedIds(new Set())

  const describeApiError = (data: any, fallback: string) => {
    const err = data?.error
    if (!err) return fallback
    if (typeof err === 'string') return err
    if (typeof err?.message === 'string') return err.message
    if (Array.isArray(err?.formErrors) && err.formErrors.length) return err.formErrors.join(' ')
    if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
      const parts: string[] = []
      for (const [k, v] of Object.entries(err.fieldErrors)) {
        if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.join(', ')}`)
      }
      if (parts.length) return parts.join(' \u2022 ')
    }
    try {
      return JSON.stringify(err)
    } catch {
      return fallback
    }
  }

  const approve = async (approveAll: boolean) => {
    setBusy(true)
    setSuccessMsg(null)
    try {
      if (!signerName.trim()) {
        setActionError('Signer name is required.')
        return
      }
      if (!eSign) {
        setActionError('Please confirm you approve this estimate.')
        return
      }
      if (!approveAll && selectedIds.size === 0) {
        setActionError('Select at least one item to approve.')
        return
      }

      setActionError(null)
      const res = await fetch(`/api/public/estimate-approval/${encodeURIComponent(token)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approveAll,
          selectedLineItemIds: approveAll ? undefined : Array.from(selectedIds),
          signerName: signerName.trim(),
          eSign: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setActionError(describeApiError(data, 'Approval failed.'))
        return
      }

      if (data.paymentUrl) {
        setSuccessMsg(`Approved ${data.approvedCount || 0} item(s). Redirecting to invoice...`)
        setTimeout(() => {
          window.location.href = data.paymentUrl
        }, 1500)
        return
      }

      setSuccessMsg(`Approved ${data.approvedCount || 0} item(s).`)
      await refresh()
      clearAll()
    } catch (e: any) {
      setActionError(e?.message || 'Approval failed.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="p-6 text-gray-600">Loading...</div>

  if (loadError) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Estimate Approval</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-red-600">{loadError}</div>
            <div className="mt-3">
              <Button type="button" variant="outline" onClick={refresh}>
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const renderItemRow = (it: ApprovalItem) => {
    if (it.isSubtotal) {
      return (
        <tr key={it.id} className="border-t bg-slate-50">
          <td className="p-3"></td>
          <td colSpan={isCustomerView ? 2 : 4} className="p-3 text-right text-sm font-semibold text-slate-700">
            Subtotal
          </td>
          <td className="p-3 text-right font-bold text-slate-800">
            {formatCurrency(Number(it.total || 0))}
          </td>
          <td className="p-3"></td>
        </tr>
      )
    }
    const canSelect = !it.approved
    const checked = it.approved || selectedIds.has(it.id)
    return (
      <tr key={it.id} className="border-t">
        <td className="p-3">
          <Checkbox
            checked={checked}
            disabled={!canSelect || busy}
            onCheckedChange={() => toggle(it.id)}
          />
        </td>
        <td className="p-3 font-medium">
          {it.description}
          {it.isOptional && (
            <span className="ml-2 text-xs rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-amber-700">
              Add-on
            </span>
          )}
        </td>
        <td className="p-3 text-gray-600 whitespace-pre-wrap">{it.notes || '—'}</td>
        {!isCustomerView && (
          <>
            <td className="p-3 text-right">{Number(it.quantity || 0).toFixed(2)}</td>
            <td className="p-3 text-right">{formatCurrency(Number(it.unitPrice || 0))}</td>
          </>
        )}
        <td className="p-3 text-right font-semibold">{formatCurrency(Number(it.total || 0))}</td>
        <td className="p-3">
          {it.invoiced ? (
            <span className="text-xs rounded bg-green-50 border border-green-200 px-2 py-1 text-green-800">
              Already invoiced
            </span>
          ) : it.approved ? (
            <span className="text-xs rounded bg-blue-50 border border-blue-200 px-2 py-1 text-blue-800">
              Approved
            </span>
          ) : (
            <span className="text-xs rounded bg-gray-50 border border-gray-200 px-2 py-1 text-gray-700">
              Not approved
            </span>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle>
              Approve Estimate {estimate?.estimateNumber ? `\u2022 ${estimate.estimateNumber}` : ''}
            </CardTitle>
            <Button type="button" variant="outline" asChild>
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                Download PDF
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-gray-700">
          <div>{estimate?.title || ''}</div>
          {estimate?.client?.name && <div>Client: {estimate.client.name}</div>}
          {estimate?.jobSiteAddress && <div>Address: {estimate.jobSiteAddress}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {actionError && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {actionError}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={selectAll}
              disabled={busy || allSelectableIds.length === 0}
            >
              Select All
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={clearAll}
              disabled={busy || selectedIds.size === 0}
            >
              Clear
            </Button>
            <div className="ml-auto text-sm text-gray-600">
              Selected total: {formatCurrency(selectedTotal)}
            </div>
          </div>

          <div className="overflow-x-auto border rounded-md">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left">
                  <th className="p-3 w-10"> </th>
                  <th className="p-3">{isCustomerView ? 'Line' : 'Item'}</th>
                  <th className="p-3">Description</th>
                  {!isCustomerView && (
                    <>
                      <th className="p-3 text-right">Qty</th>
                      <th className="p-3 text-right">Unit</th>
                    </>
                  )}
                  <th className="p-3 text-right">Total</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => renderItemRow(it))}
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={isCustomerView ? 5 : 7}
                      className="p-4 text-center text-gray-400 text-sm"
                    >
                      No items
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pendingOptionalItems.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-semibold text-gray-700">Optional Add-ons</h3>
                <span className="text-xs text-gray-500">Select any you would like to add</span>
              </div>
              <div className="overflow-x-auto border border-amber-200 rounded-md bg-amber-50/30">
                <table className="min-w-full text-sm">
                  <thead className="bg-amber-50">
                    <tr className="text-left">
                      <th className="p-3 w-10"> </th>
                      <th className="p-3">Item</th>
                      <th className="p-3">Description</th>
                      <th className="p-3 text-right">Qty</th>
                      <th className="p-3 text-right">Unit</th>
                      <th className="p-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingOptionalItems.map((it) => {
                      const checked = selectedIds.has(it.id)
                      return (
                        <tr key={it.id} className="border-t border-amber-200">
                          <td className="p-3">
                            <Checkbox
                              checked={checked}
                              disabled={busy}
                              onCheckedChange={() => toggle(it.id)}
                            />
                          </td>
                          <td className="p-3 font-medium">{it.description}</td>
                          <td className="p-3 text-gray-600 whitespace-pre-wrap">
                            {it.notes || '—'}
                          </td>
                          <td className="p-3 text-right">{Number(it.quantity || 0).toFixed(2)}</td>
                          <td className="p-3 text-right">
                            {formatCurrency(Number(it.unitPrice || 0))}
                          </td>
                          <td className="p-3 text-right font-semibold">
                            {formatCurrency(Number(it.total || 0))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Signer Name</label>
              <Input
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="flex items-end gap-2">
              <Checkbox checked={eSign} onCheckedChange={(v) => setESign(Boolean(v))} />
              <span className="text-sm">I approve this estimate</span>
            </div>
          </div>

          {successMsg && <div className="text-green-700 text-sm">{successMsg}</div>}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => approve(true)}
              disabled={busy || allSelectableIds.length === 0}
            >
              Approve All
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => approve(false)}
              disabled={busy || selectedIds.size === 0}
            >
              Approve Selected Items
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
