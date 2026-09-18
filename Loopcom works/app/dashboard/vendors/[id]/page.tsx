'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Edit, Plus, ShoppingCart, Package, FileText, Eye, Download, Trash2, Building2, Phone, Mail, Globe, MapPin, DollarSign, Calendar } from 'lucide-react'
import Link from 'next/link'

interface VendorDetail {
  id: string
  name: string
  vendorCode: string | null
  status: string
  email: string | null
  phone: string | null
  website: string | null
  notes: string | null
  billingStreet: string | null
  billingCity: string | null
  billingState: string | null
  billingZip: string | null
  billingCountry: string | null
  shippingStreet: string | null
  shippingCity: string | null
  shippingState: string | null
  shippingZip: string | null
  shippingCountry: string | null
  paymentTerms: string
  customTermsText: string | null
  taxId: string | null
  defaultCurrency: string | null
  contacts: Array<{
    id: string
    name: string
    title: string | null
    email: string | null
    phone: string | null
    isPrimary: boolean
    notes: string | null
  }>
  purchaseOrders: Array<{
    id: string
    poNumber: string
    status: string
    total: string
    orderDate: string | null
    expectedDate: string | null
    receivedDate: string | null
  }>
  items: Array<{
    id: string
    name: string
    sku: string | null
    type: string
    defaultUnitPrice: string
    isActive: boolean
  }>
  attachments: Array<{
    id: string
    fileName: string
    fileSize: number
    mimeType: string
    url: string
    createdAt: string
  }>
  metrics: {
    totalSpend: number
    openPOCount: number
    totalPOCount: number
    itemsCount: number
  }
  createdAt: string
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

const poStatusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  PENDING_APPROVAL: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  ORDERED: 'bg-purple-100 text-purple-800',
  RECEIVED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
}

export default function VendorDetailPage() {
  const params = useParams()
  const router = useRouter()
  const vendorId = params.id as string
  const [vendor, setVendor] = useState<VendorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')

  useEffect(() => {
    fetchVendor()
  }, [vendorId])

  const fetchVendor = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/vendors/${vendorId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        console.error('Failed to fetch vendor:', error)
        setVendor(null)
        setLoading(false)
        return
      }

      const data = await response.json()
      if (data.vendor) {
        setVendor(data.vendor)
      } else {
        setVendor(null)
      }
    } catch (error) {
      console.error('Failed to fetch vendor:', error)
      setVendor(null)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!vendor) return

    if (!confirm(`Are you sure you want to delete "${vendor.name}"? This action cannot be undone.`)) {
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
        router.push('/dashboard/vendors')
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete vendor')
      }
    } catch (error) {
      console.error('Error deleting vendor:', error)
      alert('Failed to delete vendor')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading vendor...</p>
        </div>
      </div>
    )
  }

  if (!vendor) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 text-xl font-semibold mb-2">Vendor not found</div>
        <p className="text-gray-600 mb-4">The vendor you're looking for doesn't exist or you don't have permission to view it.</p>
        <Button variant="outline" onClick={() => router.push('/dashboard/vendors')}>
          ← Back to Vendors
        </Button>
      </div>
    )
  }

  const primaryContact = vendor.contacts.find(c => c.isPrimary) || vendor.contacts[0] || null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <EntityBackButton fallbackHref="/dashboard/vendors" />
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-3xl font-bold text-gray-900">{vendor.name}</h1>
              <span className={`px-3 py-1 text-sm rounded-full ${statusColors[vendor.status] || 'bg-gray-100 text-gray-800'}`}>
                {vendor.status}
              </span>
            </div>
            {vendor.vendorCode && (
              <p className="mt-1 text-gray-600">Code: {vendor.vendorCode}</p>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Link href={`/dashboard/vendors/${vendorId}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
          <Button variant="outline" onClick={handleDelete} className="text-red-600 hover:text-red-700">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Link href={`/dashboard/purchase-orders/new?vendorId=${vendorId}`}>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create PO
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="flex space-x-8">
          {['overview', 'contacts', 'purchase-orders', 'items', 'attachments'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
            </button>
          ))}
        </nav>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <>
              {/* Vendor Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Vendor Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {vendor.email && (
                      <div className="flex items-center space-x-2">
                        <Mail className="h-4 w-4 text-gray-400" />
                        <span className="text-sm text-gray-600">{vendor.email}</span>
                      </div>
                    )}
                    {vendor.phone && (
                      <div className="flex items-center space-x-2">
                        <Phone className="h-4 w-4 text-gray-400" />
                        <span className="text-sm text-gray-600">{vendor.phone}</span>
                      </div>
                    )}
                    {vendor.website && (
                      <div className="flex items-center space-x-2">
                        <Globe className="h-4 w-4 text-gray-400" />
                        <a href={vendor.website} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">
                          {vendor.website}
                        </a>
                      </div>
                    )}
                  </div>

                  {primaryContact && (
                    <div className="border-t pt-4">
                      <h3 className="font-semibold mb-2">Primary Contact</h3>
                      <div className="space-y-1">
                        <div className="font-medium">{primaryContact.name}</div>
                        {primaryContact.title && <div className="text-sm text-gray-600">{primaryContact.title}</div>}
                        {primaryContact.email && (
                          <div className="text-sm text-gray-600">{primaryContact.email}</div>
                        )}
                        {primaryContact.phone && (
                          <div className="text-sm text-gray-600">{primaryContact.phone}</div>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Addresses */}
              <Card>
                <CardHeader>
                  <CardTitle>Addresses</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <h3 className="font-semibold mb-2">Billing Address</h3>
                    {vendor.billingStreet ? (
                      <div className="text-sm text-gray-600">
                        <div>{vendor.billingStreet}</div>
                        <div>
                          {vendor.billingCity}, {vendor.billingState} {vendor.billingZip}
                        </div>
                        {vendor.billingCountry && <div>{vendor.billingCountry}</div>}
                      </div>
                    ) : (
                      <div className="text-sm text-gray-400">No billing address</div>
                    )}
                  </div>
                  {(vendor.shippingStreet || vendor.shippingCity) && (
                    <div>
                      <h3 className="font-semibold mb-2">Shipping Address</h3>
                      <div className="text-sm text-gray-600">
                        <div>{vendor.shippingStreet}</div>
                        <div>
                          {vendor.shippingCity}, {vendor.shippingState} {vendor.shippingZip}
                        </div>
                        {vendor.shippingCountry && <div>{vendor.shippingCountry}</div>}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Payment Terms */}
              <Card>
                <CardHeader>
                  <CardTitle>Payment Terms</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div>
                      <span className="font-medium">
                        {paymentTermsLabels[vendor.paymentTerms] || vendor.paymentTerms}
                      </span>
                    </div>
                    {vendor.paymentTerms === 'CUSTOM' && vendor.customTermsText && (
                      <div className="text-sm text-gray-600">{vendor.customTermsText}</div>
                    )}
                    {vendor.taxId && (
                      <div className="text-sm text-gray-600">
                        Tax ID: {vendor.taxId.replace(/\d(?=\d{4})/g, '*')}
                      </div>
                    )}
                    {vendor.defaultCurrency && (
                      <div className="text-sm text-gray-600">
                        Currency: {vendor.defaultCurrency}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {vendor.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle>Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{vendor.notes}</p>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* Contacts Tab */}
          {activeTab === 'contacts' && (
            <Card>
              <CardHeader>
                <CardTitle>Vendor Contacts</CardTitle>
                <CardDescription>Manage contacts for this vendor</CardDescription>
              </CardHeader>
              <CardContent>
                {vendor.contacts.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No contacts added yet
                  </div>
                ) : (
                  <div className="space-y-4">
                    {vendor.contacts.map((contact) => (
                      <div key={contact.id} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2">
                              <div className="font-medium">{contact.name}</div>
                              {contact.isPrimary && (
                                <span className="px-2 py-0.5 text-xs rounded-full bg-primary text-white">
                                  Primary
                                </span>
                              )}
                            </div>
                            {contact.title && (
                              <div className="text-sm text-gray-600 mt-1">{contact.title}</div>
                            )}
                            <div className="mt-2 space-y-1">
                              {contact.email && (
                                <div className="text-sm text-gray-600 flex items-center space-x-2">
                                  <Mail className="h-3 w-3" />
                                  <span>{contact.email}</span>
                                </div>
                              )}
                              {contact.phone && (
                                <div className="text-sm text-gray-600 flex items-center space-x-2">
                                  <Phone className="h-3 w-3" />
                                  <span>{contact.phone}</span>
                                </div>
                              )}
                            </div>
                            {contact.notes && (
                              <div className="text-sm text-gray-500 mt-2">{contact.notes}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Purchase Orders Tab */}
          {activeTab === 'purchase-orders' && (
            <Card>
              <CardHeader>
                <CardTitle>Purchase Orders</CardTitle>
                <CardDescription>All purchase orders for this vendor</CardDescription>
              </CardHeader>
              <CardContent>
                {vendor.purchaseOrders.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No purchase orders yet
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-4 font-semibold">PO Number</th>
                          <th className="text-left py-2 px-4 font-semibold">Status</th>
                          <th className="text-left py-2 px-4 font-semibold">Order Date</th>
                          <th className="text-left py-2 px-4 font-semibold">Expected Date</th>
                          <th className="text-right py-2 px-4 font-semibold">Total</th>
                          <th className="text-right py-2 px-4 font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendor.purchaseOrders.map((po) => (
                          <tr key={po.id} className="border-b hover:bg-gray-50">
                            <td className="py-3 px-4">
                              <Link href={`/dashboard/purchase-orders/${po.id}`} className="text-primary hover:underline">
                                {po.poNumber}
                              </Link>
                            </td>
                            <td className="py-3 px-4">
                              <span className={`px-2 py-1 text-xs rounded-full ${poStatusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>
                                {po.status}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-sm text-gray-600">
                              {po.orderDate ? formatDate(po.orderDate) : '-'}
                            </td>
                            <td className="py-3 px-4 text-sm text-gray-600">
                              {po.expectedDate ? formatDate(po.expectedDate) : '-'}
                            </td>
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(parseFloat(po.total))}
                            </td>
                            <td className="py-3 px-4">
                              <Link href={`/dashboard/purchase-orders/${po.id}`}>
                                <Button variant="ghost" size="sm">
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Items Tab */}
          {activeTab === 'items' && (
            <Card>
              <CardHeader>
                <CardTitle>Items</CardTitle>
                <CardDescription>Items that use this vendor as default</CardDescription>
              </CardHeader>
              <CardContent>
                {vendor.items.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No items linked to this vendor
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-4 font-semibold">Name</th>
                          <th className="text-left py-2 px-4 font-semibold">SKU</th>
                          <th className="text-left py-2 px-4 font-semibold">Type</th>
                          <th className="text-right py-2 px-4 font-semibold">Unit Price</th>
                          <th className="text-right py-2 px-4 font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendor.items.map((item) => (
                          <tr key={item.id} className="border-b hover:bg-gray-50">
                            <td className="py-3 px-4">
                              <Link href={`/dashboard/items/${item.id}`} className="text-primary hover:underline">
                                {item.name}
                              </Link>
                            </td>
                            <td className="py-3 px-4 text-sm text-gray-600">{item.sku || '-'}</td>
                            <td className="py-3 px-4 text-sm text-gray-600">{item.type}</td>
                            <td className="py-3 px-4 text-right">
                              {formatCurrency(parseFloat(item.defaultUnitPrice))}
                            </td>
                            <td className="py-3 px-4">
                              <Link href={`/dashboard/items/${item.id}`}>
                                <Button variant="ghost" size="sm">
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Attachments Tab */}
          {activeTab === 'attachments' && (
            <Card>
              <CardHeader>
                <CardTitle>Attachments</CardTitle>
                <CardDescription>Documents and files for this vendor</CardDescription>
              </CardHeader>
              <CardContent>
                {vendor.attachments.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No attachments yet
                  </div>
                ) : (
                  <div className="space-y-2">
                    {vendor.attachments.map((attachment) => (
                      <div key={attachment.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex items-center space-x-3">
                          <FileText className="h-5 w-5 text-gray-400" />
                          <div>
                            <div className="font-medium">{attachment.fileName}</div>
                            <div className="text-sm text-gray-500">
                              {(attachment.fileSize / 1024).toFixed(2)} KB{' \u2022 '}{formatDate(attachment.createdAt)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="sm">
                              <Download className="h-4 w-4" />
                            </Button>
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Metrics */}
          <Card>
            <CardHeader>
              <CardTitle>Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-sm text-gray-600">Total Spend</div>
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(vendor.metrics.totalSpend)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Open Purchase Orders</div>
                <div className="text-2xl font-bold text-gray-900">
                  {vendor.metrics.openPOCount}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Total Purchase Orders</div>
                <div className="text-2xl font-bold text-gray-900">
                  {vendor.metrics.totalPOCount}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Linked Items</div>
                <div className="text-2xl font-bold text-gray-900">
                  {vendor.metrics.itemsCount}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Created:</span>
                <span>{formatDate(vendor.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Last Updated:</span>
                <span>{formatDate(vendor.updatedAt)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
