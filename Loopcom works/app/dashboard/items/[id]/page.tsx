'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils'
import { Edit, Copy, Archive, Package } from 'lucide-react'
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
    email: string | null
    phone: string | null
  } | null
  category: {
    id: string
    name: string
  } | null
  tags: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
  bundleDefinition?: {
    id: string
    name: string
    pricingStrategy: string
  } | null
  usageCounts: {
    estimates: number
    invoices: number
    purchaseOrders: number
  }
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

export default function ItemDetailPage() {
  const router = useRouter()
  const params = useParams()
  const itemId = params?.id as string | undefined

  const [item, setItem] = useState<Item | null>(null)
  const [bundleComponents, setBundleComponents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (itemId) {
      fetchItem()
    }
  }, [itemId])

  const fetchItem = async () => {
    if (!itemId) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${itemId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to load item')
        router.push('/dashboard/items')
        return
      }

      const data = await response.json()
      setItem(data.item)

      // If it's a bundle, fetch bundle components
      if (data.item.kind === 'BUNDLE' && data.item.bundleDefinition?.id) {
        const bundleResponse = await fetch(`/api/items/bundles/${data.item.bundleDefinition.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (bundleResponse.ok) {
          const bundleData = await bundleResponse.json()
          setBundleComponents(bundleData.bundle?.components || [])
        }
      }
    } catch (error) {
      console.error('Error fetching item:', error)
      alert('Failed to load item')
    } finally {
      setLoading(false)
    }
  }

  const handleDuplicate = async () => {
    if (!item) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: `${item.name} (Copy)`,
          sku: item.sku ? `${item.sku}-COPY` : null,
          type: item.type,
          description: item.description,
          unit: item.unit,
          defaultUnitCost: item.defaultUnitCost,
          defaultUnitPrice: item.defaultUnitPrice,
          taxable: item.taxable,
          taxRate: item.taxRate,
          isActive: item.isActive,
          vendorId: item.vendor?.id || null,
          categoryId: item.category?.id || null,
          tags: item.tags,
          notes: item.notes,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        router.push(`/dashboard/items/${data.item.id}`)
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to duplicate item')
      }
    } catch (error) {
      console.error('Error duplicating item:', error)
      alert('Failed to duplicate item')
    }
  }

  const handleToggleActive = async () => {
    if (!item) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${item.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isActive: !item.isActive }),
      })

      if (response.ok) {
        fetchItem()
      } else {
        alert('Failed to update item')
      }
    } catch (error) {
      console.error('Toggle active error:', error)
      alert('Failed to update item')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading item...</p>
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="text-center py-12">
        <Package className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-2 text-sm font-medium text-gray-900">Item not found</h3>
        <p className="mt-1 text-sm text-gray-500">The item you're looking for doesn't exist.</p>
        <div className="mt-6">
          <Link href="/dashboard/items">
            <Button>Back to Items</Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <EntityBackButton fallbackHref="/dashboard/items" />
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-3xl font-bold text-gray-900">{item.name}</h1>
              <span className={`px-2 py-1 text-xs rounded-full ${typeColors[item.type] || 'bg-gray-100 text-gray-800'}`}>
                {typeLabels[item.type] || item.type}
              </span>
              {item.isActive ? (
                <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">Active</span>
              ) : (
                <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-800">Inactive</span>
              )}
            </div>
            {item.sku && <p className="mt-1 text-sm text-gray-600">SKU: {item.sku}</p>}
          </div>
        </div>
        <div className="flex items-center space-x-2">
          {item.kind === 'BUNDLE' ? (
            <Link href={`/dashboard/items/bundles/${item.bundleDefinition?.id}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </Link>
          ) : (
            <Link href={`/dashboard/items/${item.id}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </Link>
          )}
          <Button variant="outline" onClick={handleDuplicate}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate
          </Button>
          <Button variant="outline" onClick={handleToggleActive}>
            <Archive className="mr-2 h-4 w-4" />
            {item.isActive ? 'Archive' : 'Activate'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Item Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Description</label>
                <p className="mt-1 text-gray-900">{item.description || 'No description'}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Unit</label>
                  <p className="mt-1 text-gray-900">{item.unit}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Category</label>
                  <p className="mt-1 text-gray-900">{item.category?.name || 'No category'}</p>
                </div>
              </div>

              {item.tags.length > 0 && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Tags</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {item.tags.map((tag) => (
                      <span key={tag} className="px-2 py-1 bg-gray-100 rounded-md text-sm">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {item.notes && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Internal Notes</label>
                  <p className="mt-1 text-gray-900 whitespace-pre-wrap">{item.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pricing */}
          <Card>
            <CardHeader>
              <CardTitle>Pricing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Default Unit Cost</label>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {item.defaultUnitCost ? formatCurrency(item.defaultUnitCost) : 'Not set'}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Default Unit Price</label>
                  <p className="mt-1 text-lg font-semibold text-primary">
                    {formatCurrency(item.defaultUnitPrice)}
                  </p>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">Taxable</span>
                  <span className={item.taxable ? 'text-green-600' : 'text-gray-400'}>
                    {item.taxable ? 'Yes' : 'No'}
                  </span>
                </div>
                {item.taxable && item.taxRate && (
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">Tax Rate Override</span>
                    <span className="text-gray-900">{(item.taxRate * 100).toFixed(2)}%</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Usage */}
          <Card>
            <CardHeader>
              <CardTitle>Usage</CardTitle>
              <CardDescription>Where this item is being used</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Estimates</label>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{item.usageCounts.estimates}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Invoices</label>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{item.usageCounts.invoices}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Purchase Orders</label>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{item.usageCounts.purchaseOrders}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Vendor */}
          {item.vendor && (
            <Card>
              <CardHeader>
                <CardTitle>Default Vendor</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <p className="font-medium text-gray-900">{item.vendor.name}</p>
                  {item.vendor.email && (
                    <p className="text-sm text-gray-600">{item.vendor.email}</p>
                  )}
                  {item.vendor.phone && (
                    <p className="text-sm text-gray-600">{item.vendor.phone}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Metadata */}
          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Created</span>
                <span className="text-gray-900">{new Date(item.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Last Updated</span>
                <span className="text-gray-900">{new Date(item.updatedAt).toLocaleDateString()}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
