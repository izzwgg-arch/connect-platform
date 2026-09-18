'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { openFromList } from '@/lib/navigation/nav-stack'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ViewModeSelector } from '@/components/ui/ViewModeSelector'
import { useViewMode } from '@/hooks/useViewMode'
import { RowCompactItem } from '@/components/lists/RowCompactItem'
import { RowDetailedItem } from '@/components/lists/RowDetailedItem'
import { TableView } from '@/components/lists/TableView'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Filter, Package, Copy } from 'lucide-react'
import Link from 'next/link'

interface PurchaseOrder {
  id: string
  poNumber: string
  status: string
  expectedDate: string | null
  orderDate: string | null
  vendor: string
  vendorId: string | null
  vendorRef: {
    id: string
    name: string
    email: string | null
  } | null
  job: {
    id: string
    jobNumber: string
    title: string
  } | null
  subtotal: number
  tax?: number
  shipping?: number
  total: number
  jobSiteAddress?: string
}

function getPurchaseOrderTag(po: PurchaseOrder): string {
  if (po.job?.jobNumber) return `JOB-${po.job.jobNumber}`
  if (po.vendorRef?.name) return po.vendorRef.name
  if (po.vendor) return po.vendor
  return '-'
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  PENDING_APPROVAL: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  ORDERED: 'bg-purple-100 text-purple-800',
  RECEIVED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
}

function renderJobSiteAddress(address?: string) {
  const value = String(address || '').trim()
  if (!value) return null
  return (
    <span className="block max-w-[260px] truncate" title={value}>
      {value}
    </span>
  )
}

export default function PurchaseOrdersPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('purchase-orders')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } = usePersistedSort('purchase-orders')
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [duplicating, setDuplicating] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [viewMode, setViewMode] = useViewMode('purchaseOrders', 'grid')

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  }

  useEffect(() => {
    setPage(1)
  }, [search, status])

  useEffect(() => {
    fetchPurchaseOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, page])

  const fetchPurchaseOrders = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search,
        status,
        page: String(page),
        limit: '50',
      })

      const response = await fetch(`/api/purchase-orders?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setPurchaseOrders(data.purchaseOrders || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch purchase orders:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDuplicateSelected = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(`Duplicate ${selectedIds.length} selected purchase order(s)?`)) return

    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      for (const poId of selectedIds) {
        const response = await fetch(`/api/purchase-orders/${poId}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          alert(data.error || 'Failed to duplicate one or more purchase orders')
          break
        }
      }

      setSelectedIds([])
      fetchPurchaseOrders()
    } catch (error) {
      console.error('Failed duplicating purchase orders:', error)
      alert('Failed to duplicate selected purchase orders')
    } finally {
      setDuplicating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading purchase orders...</p>
        </div>
      </div>
    )
  }

  const totalValue = purchaseOrders.reduce((sum, po) => sum + po.total, 0)
  const openPOs = purchaseOrders.filter((po) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED'].includes(po.status))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Purchase Orders</h1>
          <p className="mt-2 text-gray-600">Manage vendor purchase orders and costs</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          <Button
            variant="outline"
            onClick={handleDuplicateSelected}
            disabled={selectedIds.length === 0 || duplicating}
          >
            <Copy className="mr-2 h-4 w-4" />
            {duplicating ? 'Duplicating...' : `Duplicate${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
          </Button>
          <Button onClick={() => router.push('/dashboard/purchase-orders/new')}>
            <Plus className="mr-2 h-4 w-4" />
            New PO
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Open POs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{openPOs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total POs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{purchaseOrders.length}</div>
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
                placeholder="Search by PO #, vendor, job, client, or address..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="PENDING_APPROVAL">Pending Approval</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="ORDERED">Ordered</SelectItem>
                  <SelectItem value="RECEIVED">Received</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Purchase Orders List */}
      {viewMode === 'grid' ? (
      <div className="space-y-4">
        {purchaseOrders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No purchase orders</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating a new purchase order.
              </p>
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/purchase-orders/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New PO
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          purchaseOrders.map((po) => (
            <Card
              key={po.id}
              className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => router.push(`/dashboard/purchase-orders/${po.id}`)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <Link href={`/dashboard/purchase-orders/${po.id}`}>
                      <CardTitle className="text-lg hover:text-primary cursor-pointer">
                        {po.poNumber}
                      </CardTitle>
                    </Link>
                    <CardDescription className="mt-1">
                      Vendor: {po.vendorRef?.name || po.vendor}
                      {po.job && ` \u2022 Job ${po.job.jobNumber}`}
                      {po.expectedDate && ` \u2022 Expected: ${formatDate(po.expectedDate)}`}
                    </CardDescription>
                    {po.jobSiteAddress ? (
                      <p className="mt-1 text-xs text-gray-500" title={po.jobSiteAddress}>
                        <span className="inline-block max-w-[320px] truncate">{po.jobSiteAddress}</span>
                      </p>
                    ) : null}
                    <div className="mt-1 text-xs text-gray-500">Tag: {getPurchaseOrderTag(po)}</div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(po.id)}
                      onChange={(e) =>
                        setSelectedIds((prev) =>
                          e.target.checked ? [...prev, po.id] : prev.filter((id) => id !== po.id)
                        )
                      }
                      className="h-4 w-4"
                      onClick={(e) => e.stopPropagation()}
                      title="Select for duplicate"
                    />
                    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>
                      {po.status}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-600">
                    {po.orderDate && `Order Date: ${formatDate(po.orderDate)}`}
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold">{formatCurrency(po.total)}</div>
                    <div className="text-xs text-gray-500">
                      Subtotal: {formatCurrency(po.subtotal)}
                      {po.tax && po.tax > 0 && ` + Tax: ${formatCurrency(po.tax)}`}
                      {po.shipping && po.shipping > 0 && ` + Shipping: ${formatCurrency(po.shipping)}`}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {purchaseOrders.map((po) => (
            <RowCompactItem
              key={po.id}
              href={`/dashboard/purchase-orders/${po.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(po.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(po.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={po.poNumber}
              secondary={[po.vendorRef?.name || po.vendor, po.jobSiteAddress || null].filter(Boolean).join(' \u2022 ')}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>{po.status}</span>}
              amount={formatCurrency(po.total)}
              date={`${po.orderDate ? formatDate(po.orderDate) : '-'} \u2022 Tag: ${getPurchaseOrderTag(po)}`}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {purchaseOrders.map((po) => (
            <RowDetailedItem
              key={po.id}
              href={`/dashboard/purchase-orders/${po.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(po.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onChange={(e) => toggleSelected(po.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              }
              primary={po.poNumber}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>{po.status}</span>}
              line2={[
                po.vendorRef?.name || po.vendor,
                po.job ? `Job ${po.job.jobNumber}` : null,
                po.jobSiteAddress || null,
              ].filter(Boolean).join(' \u2022 ')}
              rightTop={formatCurrency(po.total)}
              rightBottom={`${po.orderDate ? formatDate(po.orderDate) : 'No order date'} \u2022 Tag: ${getPurchaseOrderTag(po)}`}
            />
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={purchaseOrders}
          rowKey={(po) => po.id}
          onRowClick={(po) => openFromList(router, { entity: 'purchase-orders', detailHref: `/dashboard/purchase-orders/${po.id}`, itemId: po.id })}
          columns={[
            {
              key: 'select',
              header: '',
              render: (po) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(po.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleSelected(po.id, e.target.checked)}
                  className="h-4 w-4"
                  title="Select for duplicate"
                />
              ),
              className: 'w-10',
              headerClassName: 'w-10',
            },
            {
              key: 'po',
              header: 'PO',
              sortValue: (po) => po.poNumber,
              render: (po) => <span className="font-medium">{po.poNumber}</span>,
            },
            {
              key: 'vendor',
              header: 'Vendor',
              sortValue: (po) => po.vendorRef?.name || po.vendor,
              render: (po) => po.vendorRef?.name || po.vendor,
            },
            {
              key: 'tag',
              header: 'Tag',
              sortValue: (po) => getPurchaseOrderTag(po),
              render: (po) => getPurchaseOrderTag(po),
            },
            {
              key: 'jobSiteAddress',
              header: 'Job Site Address',
              sortValue: () => '',
              render: (po) => renderJobSiteAddress(po.jobSiteAddress),
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (po) => po.status,
              render: (po) => <span className={`px-2 py-1 text-xs rounded-full ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>{po.status}</span>,
            },
            {
              key: 'total',
              header: 'Total',
              sortValue: (po) => po.total,
              render: (po) => formatCurrency(po.total),
            },
          ]}
        />
      )}

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={loading}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}
