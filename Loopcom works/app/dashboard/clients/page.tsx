'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { openFromList } from '@/lib/navigation/nav-stack'

import { useEffect, useMemo, useState } from 'react'
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
import { formatCurrency } from '@/lib/utils'
import { Plus, Search, Phone, Mail, Building2, Filter, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useDocumentListAccess } from '@/hooks/useDocumentListAccess'
import { CreateOnlyAccessCard } from '@/components/permissions/CreateOnlyAccessCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

interface Client {
  id: string
  parentId?: string | null
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  isActive: boolean
  openInvoiceBalance?: string
  /** When this client is a parent with sub-clients, combined open AR (parent + all children). */
  openInvoiceBalanceWithSubClients?: string | null
  contacts: Array<{
    id: string
    firstName: string
    lastName: string
    email: string | null
    phone: string | null
    title: string | null
    isPrimary: boolean
  }>
  _count: {
    jobs: number
    invoices: number
  }
  parent?: {
    id: string
    name: string
  } | null
}

function clientListBalance(c: Client) {
  return c.openInvoiceBalanceWithSubClients ?? c.openInvoiceBalance ?? '0'
}

export default function ClientsPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('clients')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } = usePersistedSort('clients')
  const { permissionsLoading, canViewList, canCreate } = useDocumentListAccess(
    'clients.view',
    'clients.create'
  )
  const [clients, setClients] = useState<Client[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [viewMode, setViewMode] = useViewMode('clients', 'grid')

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  }

  useEffect(() => {
    // Reset to first page on filter changes.
    setPage(1)
  }, [debouncedSearch, status])

  useEffect(() => {
    if (permissionsLoading) return
    fetchClients()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, page, permissionsLoading, canViewList])

  const fetchClients = async () => {
    if (!canViewList) {
      setClients([])
      setInitialLoading(false)
      setIsFetching(false)
      return
    }

    setIsFetching(true)
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search: debouncedSearch,
        status,
        page: String(page),
        limit: '50',
      })

      const response = await fetch(`/api/clients?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setClients(data.clients || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch clients:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }

  const handleDelete = async (clientId: string, clientName: string) => {
    if (!confirm(`Are you sure you want to permanently delete the client "${clientName}"? This action cannot be undone.`)) {
      return
    }

    setDeletingId(clientId)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to delete client' }))
        alert(errorData.error || 'Failed to delete client')
        return
      }

      // Refresh the list
      fetchClients()
    } catch (error) {
      console.error('Failed to delete client:', error)
      alert('Failed to delete client. Please try again.')
    } finally {
      setDeletingId(null)
    }
  }

  const flattenedClients = useMemo(() => {
    const byParent = new Map<string, Client[]>()
    const allIds = new Set(clients.map((c) => c.id))
    const roots: Client[] = []

    for (const client of clients) {
      if (client.parentId && allIds.has(client.parentId)) {
        const list = byParent.get(client.parentId) || []
        list.push(client)
        byParent.set(client.parentId, list)
      } else {
        roots.push(client)
      }
    }

    const sortByName = (a: Client, b: Client) => a.name.localeCompare(b.name)
    roots.sort(sortByName)
    byParent.forEach((list) => list.sort(sortByName))

    const output: Array<{ client: Client; isSubClient: boolean }> = []
    const visit = (client: Client) => {
      output.push({ client, isSubClient: false })
      const children = byParent.get(client.id) || []
      for (const child of children) {
        output.push({ client: child, isSubClient: true })
      }
    }

    for (const root of roots) visit(root)
    return output
  }, [clients])

  const visibleClientIds = useMemo(() => flattenedClients.map((x) => x.client.id), [flattenedClients])
  const allVisibleSelected = useMemo(
    () => visibleClientIds.length > 0 && visibleClientIds.every((id) => selectedIds.includes(id)),
    [selectedIds, visibleClientIds]
  )
  const someVisibleSelected = useMemo(
    () => visibleClientIds.some((id) => selectedIds.includes(id)) && !allVisibleSelected,
    [allVisibleSelected, selectedIds, visibleClientIds]
  )

  useEffect(() => {
    // Drop selections that are no longer on the page (after search/filter refresh).
    const visible = new Set(visibleClientIds)
    setSelectedIds((prev) => prev.filter((id) => visible.has(id)))
  }, [visibleClientIds])

  const setSelectAllVisible = (checked: boolean) => {
    if (!checked) {
      setSelectedIds([])
      return
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...visibleClientIds])))
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0 || bulkDeleting) return
    if (
      !confirm(
        `Delete ${selectedIds.length} selected client(s)? Clients with jobs/invoices will be skipped. This action cannot be undone.`
      )
    ) {
      return
    }

    setBulkDeleting(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch('/api/clients', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids: selectedIds }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to delete selected clients')
        return
      }

      const blocked = Array.isArray(data.blocked) ? data.blocked : []
      const deletedCount = Number(data.deletedCount || 0)
      setSelectedIds([])
      await fetchClients()

      if (blocked.length) {
        alert(
          `Deleted ${deletedCount} client(s). Skipped ${blocked.length} blocked client(s) (has jobs/invoices).`
        )
      } else {
        alert(`Deleted ${deletedCount} client(s).`)
      }
    } catch (error) {
      console.error('Failed to bulk delete clients:', error)
      alert('Failed to delete selected clients. Please try again.')
    } finally {
      setBulkDeleting(false)
    }
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading clients...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Clients</h1>
          <p className="mt-2 text-gray-600">Manage your clients and contacts</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          {canViewList && (
            <Button
              variant="outline"
              onClick={handleDeleteSelected}
              disabled={selectedIds.length === 0 || bulkDeleting}
              className="text-red-700 border-red-200 hover:bg-red-50"
              title="Delete selected clients"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {bulkDeleting ? 'Deleting...' : `Delete${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
            </Button>
          )}
          {canCreate && (
          <Button onClick={() => router.push('/dashboard/clients/new')}>
            <Plus className="mr-2 h-4 w-4" />
            New Client
          </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <CreateOnlyAccessCard
          icon={Building2}
          entityLabel="clients"
          createButtonLabel="New Client"
          canCreate={canCreate}
          onCreate={() => router.push('/dashboard/clients/new')}
        />
      )}

      {canViewList && (
        <>
      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected
                }}
                onChange={(e) => setSelectAllVisible(e.target.checked)}
                className="h-4 w-4"
                title="Select all visible clients"
              />
              <span className="text-sm text-gray-600">Select all</span>
            </div>
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by name, company, email, phone, contact, or address..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All Clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Clients List */}
      {clients.length === 0 ? (
        <div className="text-center py-12">
          <Building2 className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">No clients</h3>
          <p className="mt-1 text-sm text-gray-500">Get started by creating a new client.</p>
          <div className="mt-6">
            <Button onClick={() => router.push('/dashboard/clients/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Client
            </Button>
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {flattenedClients.map(({ client, isSubClient }) => {
            const primaryContact = client.contacts.find((c) => c.isPrimary) || client.contacts[0]
            return (
              <Card key={client.id} className={`hover:shadow-lg transition-shadow ${isSubClient ? 'ml-4 border-l-4 border-blue-300' : ''}`}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <Link href={`/dashboard/clients/${client.id}`}>
                        <CardTitle className="text-lg hover:text-primary cursor-pointer">{client.name}</CardTitle>
                      </Link>
                      {isSubClient && (
                        <div className="mt-1">
                          <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800">Sub-client</span>
                          {client.parent?.name && <span className="ml-2 text-xs text-gray-500">Parent: {client.parent.name}</span>}
                        </div>
                      )}
                      {client.companyName && <CardDescription className="mt-1">{client.companyName}</CardDescription>}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(client.id)}
                        onChange={(e) => toggleSelected(client.id, e.target.checked)}
                        className="h-4 w-4"
                        title="Select client"
                      />
                      <span className={`px-2 py-1 text-xs rounded-full ${client.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                        {client.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {primaryContact && (
                      <div className="text-sm text-gray-600">
                        <p className="font-medium">
                          {primaryContact.firstName} {primaryContact.lastName}
                        </p>
                        {primaryContact.title && <p className="text-xs text-gray-500">{primaryContact.title}</p>}
                      </div>
                    )}
                    <div className="space-y-1">
                      {client.phone && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Phone className="mr-2 h-3 w-3" />
                          {client.phone}
                        </div>
                      )}
                      {client.email && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Mail className="mr-2 h-3 w-3" />
                          {client.email}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <div className="flex items-center space-x-3 text-xs text-gray-500">
                        <span>{client._count.jobs} jobs</span>
                        <span>{client._count.invoices} invoices</span>
                      </div>
                      <div className="text-xs font-semibold text-gray-800" title="Total open balance across all unpaid invoices">
                        {formatCurrency(clientListBalance(client))}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault()
                          handleDelete(client.id, client.name)
                        }}
                        disabled={deletingId === client.id}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {flattenedClients.map(({ client }) => (
            <RowCompactItem
              key={client.id}
              href={`/dashboard/clients/${client.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(client.id)}
                  onChange={(e) => toggleSelected(client.id, e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4"
                  title="Select client"
                />
              }
              primary={client.name}
              secondary={
                `${client.companyName || client.email || client.phone || 'No contact info'} • Open: ${formatCurrency(
                  clientListBalance(client)
                )}`
              }
              status={
                <span className={`px-2 py-1 text-xs rounded-full ${client.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                  {client.isActive ? 'Active' : 'Inactive'}
                </span>
              }
              amount={<span>{formatCurrency(clientListBalance(client))}</span>}
              date={
                <span>
                  {client._count.jobs} jobs • {client._count.invoices} invoices
                </span>
              }
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault()
                    handleDelete(client.id, client.name)
                  }}
                  disabled={deletingId === client.id}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              }
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {flattenedClients.map(({ client }) => (
            <RowDetailedItem
              key={client.id}
              href={`/dashboard/clients/${client.id}`}
              leading={
                <input
                  type="checkbox"
                  checked={selectedIds.includes(client.id)}
                  onChange={(e) => toggleSelected(client.id, e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4"
                  title="Select client"
                />
              }
              primary={client.name}
              status={
                <span className={`px-2 py-1 text-xs rounded-full ${client.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                  {client.isActive ? 'Active' : 'Inactive'}
                </span>
              }
              line2={`${client.companyName || 'No company'} • ${client.email || 'No email'} • ${client.phone || 'No phone'}`}
              rightTop={<span>{formatCurrency(clientListBalance(client))}</span>}
              rightBottom={
                <span>
                  {client._count.jobs} jobs • {client._count.invoices} invoices
                </span>
              }
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault()
                    handleDelete(client.id, client.name)
                  }}
                  disabled={deletingId === client.id}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              }
            />
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={flattenedClients.map((x) => x.client)}
          rowKey={(client) => client.id}
          onRowClick={(client) => openFromList(router, { entity: 'clients', detailHref: `/dashboard/clients/${client.id}`, itemId: client.id })}
          columns={[
            {
              key: 'select',
              header: '',
              headerClassName: 'w-[40px]',
              render: (client) => (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(client.id)}
                  onChange={(e) => toggleSelected(client.id, e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4"
                  title="Select client"
                />
              ),
            },
            {
              key: 'name',
              header: 'Client',
              sortValue: (client) => client.name,
              render: (client) => <span className="font-medium">{client.name}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (client) => (client.isActive ? 1 : 0),
              render: (client) => (
                <span className={`px-2 py-1 text-xs rounded-full ${client.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                  {client.isActive ? 'Active' : 'Inactive'}
                </span>
              ),
            },
            {
              key: 'company',
              header: 'Company',
              sortValue: (client) => client.companyName || '',
              render: (client) => client.companyName || '-',
            },
            {
              key: 'jobs',
              header: 'Jobs',
              sortValue: (client) => client._count.jobs,
              render: (client) => client._count.jobs,
            },
            {
              key: 'invoices',
              header: 'Invoices',
              sortValue: (client) => client._count.invoices,
              render: (client) => client._count.invoices,
            },
            {
              key: 'openBalance',
              header: 'Open Balance',
              sortValue: (client) => parseFloat(clientListBalance(client) || '0'),
              render: (client) => (
                <span className="font-medium">
                  {formatCurrency(clientListBalance(client))}
                  {client.openInvoiceBalanceWithSubClients ? (
                    <span className="ml-1 block text-[10px] font-normal text-gray-500">incl. sub-clients</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (client) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(client.id, client.name)
                  }}
                  disabled={deletingId === client.id}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              ),
            },
          ]}
        />
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
        </>
      )}
    </div>
  )
}
