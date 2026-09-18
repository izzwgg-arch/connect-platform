'use client'
import { useListRestore } from '@/hooks/useListRestore'
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
import { PaginationControls } from '@/components/ui/PaginationControls'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Plus, Search, Filter, Download, Upload, Trash2, Edit, Eye, Building2 } from 'lucide-react'
import Link from 'next/link'

interface Vendor {
  id: string
  name: string
  vendorCode: string | null
  status: string
  email: string | null
  phone: string | null
  paymentTerms: string
  contacts: Array<{
    id: string
    name: string
    email: string | null
    phone: string | null
    isPrimary: boolean
  }>
  _count: {
    purchaseOrders: number
    items: number
  }
  updatedAt: string
}

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  INACTIVE: 'bg-gray-100 text-gray-800',
}

const paymentTermsLabels: Record<string, string> = {
  NET_15: 'Net 15',
  NET_30: 'Net 30',
  NET_45: 'Net 45',
  DUE_ON_RECEIPT: 'Due on Receipt',
  CUSTOM: 'Custom',
}

export default function VendorsPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('vendors')
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [paymentTermsFilter, setPaymentTermsFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [qboImporting, setQboImporting] = useState(false)
  const [viewMode, setViewMode] = useViewMode('vendors', 'table')

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, paymentTermsFilter])

  useEffect(() => {
    fetchVendors()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, paymentTermsFilter, page])

  const fetchVendors = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search,
        status: statusFilter,
        paymentTerms: paymentTermsFilter !== 'all' ? paymentTermsFilter : '',
        page: String(page),
        limit: '100',
      })

      const response = await fetch(`/api/vendors?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        console.error('Failed to fetch vendors')
        setVendors([])
        setLoading(false)
        return
      }

      const data = await response.json()
      setVendors(data.vendors || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Error fetching vendors:', error)
      setVendors([])
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (vendorId: string, vendorName: string) => {
    if (!confirm(`Are you sure you want to delete "${vendorName}"? This action cannot be undone.`)) {
      return
    }

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/vendors/${vendorId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.ok) {
        fetchVendors()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete vendor')
      }
    } catch (error) {
      console.error('Error deleting vendor:', error)
      alert('Failed to delete vendor')
    }
  }

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/vendors/export', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        alert(error.error || 'Failed to export vendors')
        return
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vendors-export-${new Date().toISOString().split('T')[0]}.csv`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('Export vendors error:', error)
      alert('Failed to export vendors')
    }
  }

  const handleImport = async () => {
    if (!importFile) {
      alert('Please select a file')
      return
    }

    setImporting(true)
    try {
      const csvData = await importFile.text()
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/vendors/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ csvData }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to import vendors')
        return
      }

      alert(`Import complete: ${data.imported} imported, ${data.skipped} skipped, ${data.errors} errors`)
      fetchVendors()
      setShowImportDialog(false)
      setImportFile(null)
    } catch (error) {
      console.error('Import vendors error:', error)
      alert('Failed to import vendors')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFromQuickBooks = async () => {
    if (!confirm('Import all vendors from QuickBooks? Existing vendors matched by QuickBooks ID or name will be updated.')) return
    setQboImporting(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/vendors/import-quickbooks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'QuickBooks vendor import failed.')
        return
      }
      alert(
        `QuickBooks vendors: ${data.fetchedFromQuickBooks || 0} fetched. Created ${data.created || 0}, updated ${data.updated || 0}, skipped ${data.skipped || 0}.`
      )
      if (Array.isArray(data.errors) && data.errors.length) {
        console.warn('Vendor import errors:', data.errors)
      }
      await fetchVendors()
    } catch (e) {
      console.error(e)
      alert('QuickBooks vendor import failed.')
    } finally {
      setQboImporting(false)
    }
  }

  const handleImportDialogOpenChange = (open: boolean) => {
    if (importing && !open) return
    setShowImportDialog(open)
    if (!open) {
      setImportFile(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading vendors...</p>
        </div>
      </div>
    )
  }

  const primaryContact = (vendor: Vendor) => {
    return vendor.contacts.find(c => c.isPrimary) || vendor.contacts[0] || null
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Vendors</h1>
          <p className="mt-2 text-gray-600">Manage your suppliers and vendors</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          <Button onClick={handleExport} variant="outline">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={() => setShowImportDialog(true)} variant="outline">
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button onClick={() => void handleImportFromQuickBooks()} variant="outline" disabled={qboImporting}>
            {qboImporting ? 'Importing…' : 'Import from QuickBooks'}
          </Button>
          <Button onClick={() => router.push('/dashboard/vendors/new')}>
            <Plus className="mr-2 h-4 w-4" />
            New Vendor
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <Input
                  placeholder="Search vendors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Select value={paymentTermsFilter} onValueChange={setPaymentTermsFilter}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All Payment Terms" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Payment Terms</SelectItem>
                <SelectItem value="NET_15">Net 15</SelectItem>
                <SelectItem value="NET_30">Net 30</SelectItem>
                <SelectItem value="NET_45">Net 45</SelectItem>
                <SelectItem value="DUE_ON_RECEIPT">Due on Receipt</SelectItem>
                <SelectItem value="CUSTOM">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Vendors List/Table */}
      {vendors.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <Building2 className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No vendors found</h3>
            <p className="text-gray-600 mb-4">
              {search || statusFilter !== 'all' || paymentTermsFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'Get started by creating your first vendor'}
            </p>
            <div className="flex justify-center flex-wrap gap-2">
              <Button onClick={() => router.push('/dashboard/vendors/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Vendor
              </Button>
              <Button variant="outline" onClick={() => setShowImportDialog(true)}>
                <Upload className="mr-2 h-4 w-4" />
                Import CSV
              </Button>
              <Button variant="outline" onClick={() => void handleImportFromQuickBooks()} disabled={qboImporting}>
                {qboImporting ? 'Importing…' : 'Import from QuickBooks'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {vendors.map((vendor) => {
            const contact = primaryContact(vendor)
            return (
              <Card key={vendor.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{vendor.name}</CardTitle>
                    <span className={`px-2 py-1 text-xs rounded-full ${statusColors[vendor.status] || 'bg-gray-100 text-gray-800'}`}>
                      {vendor.status}
                    </span>
                  </div>
                  <CardDescription>{paymentTermsLabels[vendor.paymentTerms] || vendor.paymentTerms}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="text-sm text-muted-foreground">{contact?.email || vendor.email || '-'}</div>
                  <div className="text-sm text-muted-foreground">{contact?.phone || vendor.phone || '-'}</div>
                  <div className="flex justify-end gap-1">
                    <Link href={`/dashboard/vendors/${vendor.id}`}>
                      <Button variant="ghost" size="sm"><Eye className="h-4 w-4" /></Button>
                    </Link>
                    <Link href={`/dashboard/vendors/${vendor.id}/edit`}>
                      <Button variant="ghost" size="sm"><Edit className="h-4 w-4" /></Button>
                    </Link>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(vendor.id, vendor.name)} className="text-red-600 hover:text-red-700">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {vendors.map((vendor) => (
            <RowCompactItem
              key={vendor.id}
              href={`/dashboard/vendors/${vendor.id}`}
              primary={vendor.name}
              secondary={paymentTermsLabels[vendor.paymentTerms] || vendor.paymentTerms}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[vendor.status] || 'bg-gray-100 text-gray-800'}`}>{vendor.status}</span>}
              amount={vendor._count.purchaseOrders}
              date={formatDate(vendor.updatedAt)}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {vendors.map((vendor) => (
            <RowDetailedItem
              key={vendor.id}
              href={`/dashboard/vendors/${vendor.id}`}
              primary={vendor.name}
              status={<span className={`px-2 py-1 text-xs rounded-full ${statusColors[vendor.status] || 'bg-gray-100 text-gray-800'}`}>{vendor.status}</span>}
              line2={`${vendor.email || '-'} • ${vendor.phone || '-'} • ${paymentTermsLabels[vendor.paymentTerms] || vendor.paymentTerms}`}
              rightTop={`${vendor._count.purchaseOrders} POs`}
              rightBottom={formatDate(vendor.updatedAt)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Vendors ({vendors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-semibold">Vendor Name</th>
                    <th className="text-left py-3 px-4 font-semibold">Primary Contact</th>
                    <th className="text-left py-3 px-4 font-semibold">Email</th>
                    <th className="text-left py-3 px-4 font-semibold">Phone</th>
                    <th className="text-left py-3 px-4 font-semibold">Payment Terms</th>
                    <th className="text-left py-3 px-4 font-semibold">Status</th>
                    <th className="text-left py-3 px-4 font-semibold">Last Updated</th>
                    <th className="text-right py-3 px-4 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((vendor) => {
                    const contact = primaryContact(vendor)
                    return (
                      <tr key={vendor.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <Link href={`/dashboard/vendors/${vendor.id}`} className="text-primary hover:underline font-medium">
                            {vendor.name}
                          </Link>
                          {vendor.vendorCode && <div className="text-sm text-gray-500">Code: {vendor.vendorCode}</div>}
                        </td>
                        <td className="py-3 px-4">{contact ? <div className="font-medium">{contact.name}</div> : <span className="text-gray-400">No contact</span>}</td>
                        <td className="py-3 px-4">{contact?.email || vendor.email || <span className="text-gray-400">-</span>}</td>
                        <td className="py-3 px-4">{contact?.phone || vendor.phone || <span className="text-gray-400">-</span>}</td>
                        <td className="py-3 px-4">{paymentTermsLabels[vendor.paymentTerms] || vendor.paymentTerms}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-1 text-xs rounded-full ${statusColors[vendor.status] || 'bg-gray-100 text-gray-800'}`}>{vendor.status}</span>
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">{formatDate(vendor.updatedAt)}</td>
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-end space-x-2">
                            <Link href={`/dashboard/vendors/${vendor.id}`}>
                              <Button variant="ghost" size="sm"><Eye className="h-4 w-4" /></Button>
                            </Link>
                            <Link href={`/dashboard/vendors/${vendor.id}/edit`}>
                              <Button variant="ghost" size="sm"><Edit className="h-4 w-4" /></Button>
                            </Link>
                            <Button variant="ghost" size="sm" onClick={() => handleDelete(vendor.id, vendor.name)} className="text-red-600 hover:text-red-700">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={loading}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />

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
            <DialogTitle>Import Vendors from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with vendor data.
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
