'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { openFromList } from '@/lib/navigation/nav-stack'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Filter, Package, Download, Upload, Trash2, Edit, Eye, Copy } from 'lucide-react'
import Link from 'next/link'

interface Item {
  id: string
  name: string
  sku: string | null
  type: string
  kind: string
  description: string | null
  unit: string
  defaultUnitCost: number | null
  defaultUnitPrice: number
  taxable: boolean
  taxRate: number | null
  isActive: boolean
  vendor: {
    id: string
    name: string
  } | null
  category: {
    id: string
    name: string
  } | null
  tags: string[]
  updatedAt: string
}

interface ItemCategory {
  id: string
  name: string
}

const typeColors: Record<string, string> = {
  PRODUCT: 'bg-blue-100 text-blue-800',
  SERVICE: 'bg-green-100 text-green-800',
  MATERIAL: 'bg-yellow-100 text-yellow-800',
  FEE: 'bg-purple-100 text-purple-800',
}

const typeLabels: Record<string, string> = {
  PRODUCT: 'Product',
  SERVICE: 'Service',
  MATERIAL: 'Material',
  FEE: 'Fee',
}

export default function ItemsPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('items')
  const [items, setItems] = useState<Item[]>([])
  const [categories, setCategories] = useState<ItemCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [activeCount, setActiveCount] = useState(0)
  const [totalValue, setTotalValue] = useState(0)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [activeFilter, setActiveFilter] = useState('all')
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkDeleting, setBulkDeleting] = useState(false)

  // Check for bundle parameter in URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.get('kind') === 'bundle') {
      setKindFilter('BUNDLE')
    }
  }, [])

  useEffect(() => {
    // Reset to first page on filter changes.
    setPage(1)
  }, [search, typeFilter, kindFilter, categoryFilter, activeFilter])

  useEffect(() => {
    fetchItems()
    fetchCategories()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, typeFilter, kindFilter, categoryFilter, activeFilter, page])

  useEffect(() => {
    // When the filter/search changes, remove selections that are no longer visible.
    const visible = new Set(items.map((i) => i.id))
    setSelectedIds((prev) => prev.filter((id) => visible.has(id)))
  }, [items])

  const fetchCategories = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setCategories(data.categories || [])
      }
    } catch (error) {
      console.error('Error fetching categories:', error)
    }
  }

  const fetchItems = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search,
        type: typeFilter,
        kind: kindFilter,
        categoryId: categoryFilter !== 'all' ? categoryFilter : '',
        active: activeFilter !== 'all' ? activeFilter : '',
        page: String(page),
        limit: '100',
      })

      const response = await fetch(`/api/items?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        console.error('Failed to fetch items:', error)
        alert(error.error || 'Failed to fetch items')
        setItems([])
        return
      }

      const data = await response.json()
      console.log('Fetched items:', data.items?.length || 0, 'items')
      setItems(data.items || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
      setActiveCount(Number(data?.stats?.activeCount || 0))
      setTotalValue(Number(data?.stats?.totalValue || 0))
    } catch (error) {
      console.error('Failed to fetch items:', error)
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/export', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `items-export-${new Date().toISOString().split('T')[0]}.csv`
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error('Export error:', error)
      alert('Failed to export items')
    }
  }

  const handleImport = async () => {
    if (!importFile) {
      alert('Please select a file')
      return
    }

    setImporting(true)
    try {
      const text = await importFile.text()
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ csvData: text }),
      })

      if (response.ok) {
        const data = await response.json()
        alert(`Import complete: ${data.imported} imported, ${data.skipped} skipped, ${data.errors} errors`)
        if (data.details.errors.length > 0) {
          console.error('Import errors:', data.details.errors)
        }
        fetchItems()
        setShowImportDialog(false)
        setImportFile(null)
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to import items')
      }
    } catch (error) {
      console.error('Import error:', error)
      alert('Failed to import items')
    } finally {
      setImporting(false)
    }
  }

  const handleImportDialogOpenChange = (open: boolean) => {
    // Keep dialog stable while importing; close only when user cancels or import completes.
    if (importing && !open) return
    setShowImportDialog(open)
    if (!open) {
      setImportFile(null)
    }
  }

  const handleToggleActive = async (itemId: string, currentStatus: boolean) => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isActive: !currentStatus }),
      })

      if (response.ok) {
        fetchItems()
      } else {
        alert('Failed to update item')
      }
    } catch (error) {
      console.error('Toggle active error:', error)
      alert('Failed to update item')
    }
  }

  const handleDelete = async (itemId: string, itemName: string) => {
    if (!window.confirm(`Are you sure you want to delete "${itemName}"? This action cannot be undone.`)) {
      return
    }

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        fetchItems()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete item')
      }
    } catch (error) {
      console.error('Delete error:', error)
      alert('Failed to delete item')
    }
  }

  const handleDuplicateSelected = async () => {
    if (selectedIds.length === 0) return
    if (!window.confirm(`Duplicate ${selectedIds.length} selected item(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      for (const itemId of selectedIds) {
        const response = await fetch(`/api/items/${itemId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more items')
          break
        }
      }
      setSelectedIds([])
      fetchItems()
    } catch (error) {
      console.error('Duplicate error:', error)
      alert('Failed to duplicate selected items')
    } finally {
      setDuplicating(false)
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0 || bulkDeleting) return
    if (
      !window.confirm(
        `Delete ${selectedIds.length} selected item(s)? Items used in estimates/invoices/purchase orders/bundles will be skipped. This action cannot be undone.`
      )
    ) {
      return
    }

    setBulkDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids: selectedIds }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to delete selected items')
        return
      }

      const blocked = Array.isArray(data.blocked) ? data.blocked : []
      const deletedCount = Number(data.deletedCount || 0)
      setSelectedIds([])
      fetchItems()

      if (blocked.length) {
        alert(`Deleted ${deletedCount} item(s). Skipped ${blocked.length} blocked item(s) (in use).`)
      } else {
        alert(`Deleted ${deletedCount} item(s).`)
      }
    } catch (error) {
      console.error('Bulk delete error:', error)
      alert('Failed to delete selected items')
    } finally {
      setBulkDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading items...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Items</h1>
          <p className="mt-2 text-gray-600">Manage your products, services, materials, and fees</p>
        </div>
        <div className="flex items-center space-x-2">
          <Button onClick={handleExport} variant="outline">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={() => setShowImportDialog(true)} variant="outline">
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button
            onClick={handleDuplicateSelected}
            variant="outline"
            disabled={selectedIds.length === 0 || duplicating}
          >
            <Copy className="mr-2 h-4 w-4" />
            {duplicating ? 'Duplicating...' : `Duplicate${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
          </Button>
          <Button
            onClick={handleDeleteSelected}
            variant="outline"
            disabled={selectedIds.length === 0 || bulkDeleting}
            className="text-red-700 border-red-200 hover:bg-red-50"
            title="Delete selected items"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {bulkDeleting ? 'Deleting...' : `Delete${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
          </Button>
          <Button onClick={() => router.push('/dashboard/items/new')} variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            New Item
          </Button>
          <Link href="/dashboard/items/bundles/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Bundle
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Items</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active Items</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by name, SKU, or description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="PRODUCT">Product</SelectItem>
                  <SelectItem value="SERVICE">Service</SelectItem>
                  <SelectItem value="MATERIAL">Material</SelectItem>
                  <SelectItem value="FEE">Fee</SelectItem>
                </SelectContent>
              </Select>
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="All Kinds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Kinds</SelectItem>
                  <SelectItem value="SINGLE">Single Items</SelectItem>
                  <SelectItem value="BUNDLE">Bundles</SelectItem>
                </SelectContent>
              </Select>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={activeFilter} onValueChange={setActiveFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="true">Active</SelectItem>
                  <SelectItem value="false">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Items Table */}
      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No items</h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new item or importing from CSV.
            </p>
            <div className="mt-6 flex justify-center space-x-4">
              <Button onClick={() => router.push('/dashboard/items/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Item
              </Button>
              <Button onClick={() => setShowImportDialog(true)} variant="outline">
                <Upload className="mr-2 h-4 w-4" />
                Import CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-center py-3 px-2 font-medium text-gray-700">
                      <input
                        type="checkbox"
                        checked={items.length > 0 && selectedIds.length === items.length}
                        ref={(el) => {
                          if (el) el.indeterminate = selectedIds.length > 0 && selectedIds.length < items.length
                        }}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds(items.map((item) => item.id))
                          } else {
                            setSelectedIds([])
                          }
                        }}
                        className="h-4 w-4"
                        title="Select all"
                      />
                    </th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Name</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Description</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">SKU</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Type</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Unit</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Unit Cost</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Unit Price</th>
                    <th className="text-center py-3 px-4 font-medium text-gray-700">Taxable</th>
                    <th className="text-center py-3 px-4 font-medium text-gray-700">Status</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Category</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b hover:bg-gray-50">
                      <td className="py-3 px-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(item.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked
                                ? [...prev, item.id]
                                : prev.filter((id) => id !== item.id)
                            )
                          }
                          className="h-4 w-4"
                          title="Select for duplicate"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center space-x-2">
                          <Link href={`/dashboard/items/${item.id}`} className="text-primary hover:underline font-medium">
                            {item.name}
                          </Link>
                          {item.kind === 'BUNDLE' && (
                            <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-800 font-medium">
                              Bundle
                            </span>
                          )}
                        </div>
                        {item.kind === 'BUNDLE' && (
                          <div className="text-xs text-gray-500 mt-1">
                            Contains multiple items
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-600">
                        <div className="max-w-[360px] truncate" title={item.description || ''}>
                          {item.description || '-'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600">{item.sku || '-'}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 text-xs rounded-full ${typeColors[item.type] || 'bg-gray-100 text-gray-800'}`}>
                          {typeLabels[item.type] || item.type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-600">{item.unit}</td>
                      <td className="py-3 px-4 text-right text-gray-600">
                        {item.defaultUnitCost ? formatCurrency(item.defaultUnitCost) : '-'}
                      </td>
                      <td className="py-3 px-4 text-right font-medium">{formatCurrency(item.defaultUnitPrice)}</td>
                      <td className="py-3 px-4 text-center">
                        {item.taxable ? (
                          <span className="text-green-600">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {item.isActive ? (
                          <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">Active</span>
                        ) : (
                          <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-800">Inactive</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-600">{item.category?.name || '-'}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end space-x-2">
                          <Link href={`/dashboard/items/${item.id}`}>
                            <Button variant="ghost" size="sm">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                          <Link href={`/dashboard/items/${item.id}/edit`}>
                            <Button variant="ghost" size="sm">
                              <Edit className="h-4 w-4" />
                            </Button>
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(item.id, item.name)}
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between pt-2">
          <div className="text-sm text-gray-600">
            Page {page} of {totalPages} · {total} total
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Prev
            </Button>
            <Button
              variant="outline"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={handleImportDialogOpenChange}>
        <DialogContent
          onPointerDownOutside={(e) => {
            if (importing) e.preventDefault()
          }}
          onEscapeKeyDown={(e) => {
            if (importing) e.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>Import Items from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with item data. Download the template for the correct format.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">CSV File</label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setImportFile(e.target.files?.[0] || null)}
              />
            </div>
            <div className="flex justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => handleImportDialogOpenChange(false)}
                disabled={importing}
              >
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={!importFile || importing}>
                {importing ? 'Importing...' : 'Import'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
