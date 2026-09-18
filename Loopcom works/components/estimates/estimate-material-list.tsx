'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsiveTableContainer } from '@/components/layout/ResponsiveTableContainer'
import { formatCurrency } from '@/lib/utils'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'

export type MaterialLine = {
  id: string
  materialName: string
  vendorName: string | null
  vendorId?: string | null
  quantity: number
  unit: string | null
  unitPrice: number
  lineTotal: number
  notes: string | null
  sortOrder: number
}

type DraftLine = {
  materialName: string
  vendorName: string
  quantity: string
  unit: string
  unitPrice: string
  notes: string
}

const EMPTY_DRAFT: DraftLine = {
  materialName: '',
  vendorName: '',
  quantity: '1',
  unit: '',
  unitPrice: '',
  notes: '',
}

type Props = {
  estimateId?: string | null
  /** When true, use local example rows only (no API). */
  demoMode?: boolean
  initialLines?: MaterialLine[]
}

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export const EXAMPLE_MATERIAL_LINES: MaterialLine[] = [
  {
    id: 'demo-1',
    materialName: '3/4" Maple Plywood',
    vendorName: 'Atlantic Plywood',
    quantity: 12,
    unit: 'sheet',
    unitPrice: 68.5,
    lineTotal: 822,
    notes: 'A-grade face',
    sortOrder: 0,
  },
  {
    id: 'demo-2',
    materialName: '3/4" Maple Plywood',
    vendorName: 'Home Depot Pro',
    quantity: 12,
    unit: 'sheet',
    unitPrice: 74.2,
    lineTotal: 890.4,
    notes: 'Same spec – compare price',
    sortOrder: 1,
  },
  {
    id: 'demo-3',
    materialName: 'Soft-close hinge (Blum)',
    vendorName: 'Richelieu',
    quantity: 48,
    unit: 'ea',
    unitPrice: 4.85,
    lineTotal: 232.8,
    notes: null,
    sortOrder: 2,
  },
  {
    id: 'demo-4',
    materialName: 'Edge banding – maple 22mm',
    vendorName: 'CabinetParts.com',
    quantity: 250,
    unit: 'ft',
    unitPrice: 0.42,
    lineTotal: 105,
    notes: 'Pre-glued',
    sortOrder: 3,
  },
]

export function EstimateMaterialList({
  estimateId,
  demoMode = false,
  initialLines,
}: Props) {
  const sortStorageKey = `trimpro.list.prefs.estimate-material.${estimateId || (demoMode ? 'demo' : 'draft')}`
  const [lines, setLines] = useState<MaterialLine[]>(initialLines || (demoMode ? EXAMPLE_MATERIAL_LINES : []))
  const [loading, setLoading] = useState(!demoMode && !initialLines)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftLine>(EMPTY_DRAFT)
  const [sortKey, setSortKeyState] = useState<'manual' | 'material' | 'vendor' | 'price'>(() => {
    if (typeof window === 'undefined') return 'manual'
    try {
      const raw = localStorage.getItem(sortStorageKey)
      const v = raw ? (JSON.parse(raw) as { sortKey?: string }).sortKey : null
      return v === 'material' || v === 'vendor' || v === 'price' || v === 'manual' ? v : 'manual'
    } catch {
      return 'manual'
    }
  })
  const setSortKey = (next: 'manual' | 'material' | 'vendor' | 'price') => {
    setSortKeyState(next)
    try {
      localStorage.setItem(sortStorageKey, JSON.stringify({ sortKey: next }))
    } catch {
      /* ignore */
    }
  }

  const totalCost = useMemo(
    () => lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0),
    [lines]
  )

  const displayLines = useMemo(() => {
    const next = [...lines]
    if (sortKey === 'material') {
      next.sort((a, b) => a.materialName.localeCompare(b.materialName) || a.sortOrder - b.sortOrder)
    } else if (sortKey === 'vendor') {
      next.sort(
        (a, b) =>
          String(a.vendorName || '').localeCompare(String(b.vendorName || '')) ||
          a.sortOrder - b.sortOrder
      )
    } else if (sortKey === 'price') {
      next.sort((a, b) => a.unitPrice - b.unitPrice || a.sortOrder - b.sortOrder)
    } else {
      next.sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return next
  }, [lines, sortKey])

  const loadLines = async () => {
    if (demoMode || !estimateId) return
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/estimates/${estimateId}/material-lines`, {
        headers: authHeaders(),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load material list')
      setLines(Array.isArray(data.lines) ? data.lines : [])
    } catch (err: any) {
      setError(err?.message || 'Failed to load material list')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLines()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId, demoMode])

  const addLine = async () => {
    const materialName = draft.materialName.trim()
    if (!materialName) {
      setError('Material name is required')
      return
    }
    const quantity = Number(draft.quantity || 0)
    const unitPrice = Number(draft.unitPrice || 0)
    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      setError('Quantity and unit price must be valid numbers')
      return
    }

    if (demoMode || !estimateId) {
      const line: MaterialLine = {
        id: `demo-${Date.now()}`,
        materialName,
        vendorName: draft.vendorName.trim() || null,
        quantity,
        unit: draft.unit.trim() || null,
        unitPrice,
        lineTotal: quantity * unitPrice,
        notes: draft.notes.trim() || null,
        sortOrder: lines.length,
      }
      setLines((prev) => [...prev, line])
      setDraft(EMPTY_DRAFT)
      setError(null)
      return
    }

    try {
      setSaving(true)
      setError(null)
      const res = await fetch(`/api/estimates/${estimateId}/material-lines`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          materialName,
          vendorName: draft.vendorName.trim() || null,
          quantity,
          unit: draft.unit.trim() || null,
          unitPrice,
          notes: draft.notes.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to add line')
      setLines((prev) => [...prev, data.line])
      setDraft(EMPTY_DRAFT)
    } catch (err: any) {
      setError(err?.message || 'Failed to add line')
    } finally {
      setSaving(false)
    }
  }

  const deleteLine = async (lineId: string) => {
    if (demoMode || !estimateId) {
      setLines((prev) => prev.filter((line) => line.id !== lineId))
      return
    }
    try {
      setSaving(true)
      const res = await fetch(`/api/estimates/${estimateId}/material-lines/${lineId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete line')
      }
      setLines((prev) => prev.filter((line) => line.id !== lineId))
    } catch (err: any) {
      setError(err?.message || 'Failed to delete line')
    } finally {
      setSaving(false)
    }
  }

  const moveLine = async (lineId: string, direction: -1 | 1) => {
    const ordered = [...lines].sort((a, b) => a.sortOrder - b.sortOrder)
    const index = ordered.findIndex((line) => line.id === lineId)
    const swapWith = index + direction
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return

    const next = [...ordered]
    ;[next[index], next[swapWith]] = [next[swapWith], next[index]]
    const withOrder = next.map((line, sortOrder) => ({ ...line, sortOrder }))
    setLines(withOrder)
    setSortKey('manual')

    if (demoMode || !estimateId) return

    try {
      setSaving(true)
      const res = await fetch(`/api/estimates/${estimateId}/material-lines`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ orderedIds: withOrder.map((line) => line.id) }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to reorder')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to reorder')
      void loadLines()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {demoMode ? (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Material List example (dev)</CardTitle>
            <CardDescription>
              Collect vendor prices for materials needed on this estimate. Not linked to QuickBooks.
              Each row is a separate material/vendor/price line so you can compare options.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Material List</CardTitle>
            <CardDescription>
              Internal worksheet for vendor pricing. Total cost: {formatCurrency(totalCost)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={sortKey === 'manual' ? 'default' : 'outline'}
              onClick={() => setSortKey('manual')}
            >
              Manual
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortKey === 'material' ? 'default' : 'outline'}
              onClick={() => setSortKey('material')}
            >
              By material
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortKey === 'vendor' ? 'default' : 'outline'}
              onClick={() => setSortKey('vendor')}
            >
              By vendor
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortKey === 'price' ? 'default' : 'outline'}
              onClick={() => setSortKey('price')}
            >
              By price
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading material list…</p>
          ) : (
            <ResponsiveTableContainer>
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left text-sm font-semibold">Material</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold">Qty</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold">Unit</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold">Unit price</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold">Line total</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold">Notes</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayLines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No material lines yet. Add the first vendor quote below.
                      </td>
                    </tr>
                  ) : (
                    displayLines.map((line) => (
                      <tr key={line.id} className="border-b">
                        <td className="px-3 py-2 text-sm font-medium">{line.materialName}</td>
                        <td className="px-3 py-2 text-sm">{line.vendorName || '—'}</td>
                        <td className="px-3 py-2 text-right text-sm">{line.quantity}</td>
                        <td className="px-3 py-2 text-sm">{line.unit || '—'}</td>
                        <td className="px-3 py-2 text-right text-sm">{formatCurrency(line.unitPrice)}</td>
                        <td className="px-3 py-2 text-right text-sm font-medium">
                          {formatCurrency(line.lineTotal)}
                        </td>
                        <td className="px-3 py-2 text-sm text-muted-foreground">{line.notes || '—'}</td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={saving || sortKey !== 'manual'}
                              onClick={() => void moveLine(line.id, -1)}
                              title="Move up"
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={saving || sortKey !== 'manual'}
                              onClick={() => void moveLine(line.id, 1)}
                              title="Move down"
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-red-600"
                              disabled={saving}
                              onClick={() => void deleteLine(line.id)}
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ResponsiveTableContainer>
          )}

          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="mb-3 text-sm font-semibold">Add material line</p>
            <div className="grid gap-3 md:grid-cols-6">
              <div className="md:col-span-2 space-y-1">
                <Label htmlFor="material-name">Material</Label>
                <Input
                  id="material-name"
                  value={draft.materialName}
                  onChange={(e) => setDraft((prev) => ({ ...prev, materialName: e.target.value }))}
                  placeholder="e.g. Soft-close hinge"
                />
              </div>
              <div className="md:col-span-2 space-y-1">
                <Label htmlFor="vendor-name">Vendor</Label>
                <Input
                  id="vendor-name"
                  value={draft.vendorName}
                  onChange={(e) => setDraft((prev) => ({ ...prev, vendorName: e.target.value }))}
                  placeholder="e.g. Richelieu"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="qty">Qty</Label>
                <Input
                  id="qty"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.quantity}
                  onChange={(e) => setDraft((prev) => ({ ...prev, quantity: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="unit">Unit</Label>
                <Input
                  id="unit"
                  value={draft.unit}
                  onChange={(e) => setDraft((prev) => ({ ...prev, unit: e.target.value }))}
                  placeholder="ea / sheet / ft"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="unit-price">Unit price</Label>
                <Input
                  id="unit-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.unitPrice}
                  onChange={(e) => setDraft((prev) => ({ ...prev, unitPrice: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
              <div className="md:col-span-5 space-y-1">
                <Label htmlFor="notes">Notes</Label>
                <Input
                  id="notes"
                  value={draft.notes}
                  onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
              <div className="flex items-end">
                <Button type="button" className="w-full" disabled={saving} onClick={() => void addLine()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add line
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
