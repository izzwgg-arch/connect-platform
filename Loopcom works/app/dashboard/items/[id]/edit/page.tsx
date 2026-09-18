'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, Plus, X, Copy } from 'lucide-react'
import Link from 'next/link'

interface Vendor {
  id: string
  name: string
}

interface ItemCategory {
  id: string
  name: string
}

interface ItemResponse {
  item: {
    id: string
    name: string
    sku: string | null
    type: string
    description: string | null
    unit: string
    defaultUnitCost: number | null
    defaultUnitPrice: number
    pricingMode?: 'FIXED' | 'PERCENT_OF_ABOVE'
    percentOfAboveRate?: number | null
    taxable: boolean
    taxRate: number | null
    isActive: boolean
    vendorId: string | null
    categoryId: string | null
    tags: string[]
    notes: string | null
  }
}

export default function EditItemPage() {
  const router = useRouter()
  const params = useParams()
  const itemId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [categories, setCategories] = useState<ItemCategory[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    type: 'PRODUCT',
    description: '',
    unit: 'ea',
    defaultUnitCost: '',
    defaultUnitPrice: '0',
    pricingMode: 'FIXED' as 'FIXED' | 'PERCENT_OF_ABOVE',
    percentOfAboveRate: '',
    taxable: true,
    taxRate: '',
    isActive: true,
    vendorId: '',
    categoryId: '',
    notes: '',
  })

  useEffect(() => {
    if (itemId) {
      fetchItem()
      fetchVendors()
      fetchCategories()
    }
  }, [itemId])

  const fetchVendors = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/vendors?limit=1000', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setVendors(data.vendors || [])
      }
    } catch (error) {
      console.error('Error fetching vendors:', error)
    }
  }

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

      const data: ItemResponse = await response.json()
      const item = data.item

      setFormData({
        name: item.name,
        sku: item.sku || '',
        type: item.type,
        description: item.description || '',
        unit: item.unit,
        defaultUnitCost: item.defaultUnitCost?.toString() || '',
        defaultUnitPrice: item.defaultUnitPrice.toString(),
        pricingMode: item.pricingMode === 'PERCENT_OF_ABOVE' ? 'PERCENT_OF_ABOVE' : 'FIXED',
        percentOfAboveRate: item.percentOfAboveRate != null ? item.percentOfAboveRate.toString() : '',
        taxable: item.taxable,
        taxRate: item.taxRate?.toString() || '',
        isActive: item.isActive,
        vendorId: item.vendorId || '',
        categoryId: item.categoryId || '',
        notes: item.notes || '',
      })

      setTags(item.tags || [])
    } catch (error) {
      console.error('Error fetching item:', error)
      alert('Failed to load item')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/categories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newCategoryName }),
      })

      if (response.ok) {
        const data = await response.json()
        setCategories([...categories, data.category])
        setFormData({ ...formData, categoryId: data.category.id })
        setNewCategoryName('')
        setShowNewCategory(false)
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to create category')
      }
    } catch (error) {
      console.error('Error creating category:', error)
      alert('Failed to create category')
    }
  }

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()])
      setTagInput('')
    }
  }

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag))
  }

  const calculatePriceFromCost = () => {
    const cost = parseFloat(formData.defaultUnitCost)
    if (cost && !isNaN(cost)) {
      const markup = 1.5 // 50% markup default
      const price = cost * markup
      setFormData({ ...formData, defaultUnitPrice: price.toFixed(2) })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          defaultUnitCost: formData.defaultUnitCost ? parseFloat(formData.defaultUnitCost) : null,
          defaultUnitPrice: (() => {
            const p = parseFloat(formData.defaultUnitPrice)
            return Number.isFinite(p) ? p : 0
          })(),
          percentOfAboveRate: formData.percentOfAboveRate ? parseFloat(formData.percentOfAboveRate) : null,
          taxRate: formData.taxRate ? parseFloat(formData.taxRate) : null,
          vendorId: formData.vendorId || null,
          categoryId: formData.categoryId || null,
          tags,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to update item')
        return
      }

      router.replace(`/dashboard/items/${itemId}`)
    } catch (error) {
      console.error('Error updating item:', error)
      alert('Failed to update item')
    } finally {
      setSaving(false)
    }
  }

  const handleDuplicate = async () => {
    if (!itemId) return
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/${itemId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate item')
        return
      }

      if (data?.id) {
        router.push(`/dashboard/items/${data.id}/edit`)
      } else {
        router.push('/dashboard/items')
      }
    } catch (error) {
      console.error('Duplicate item error:', error)
      alert('Failed to duplicate item')
    } finally {
      setDuplicating(false)
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

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref={`/dashboard/items/${itemId}`} parentHref={`/dashboard/items/${itemId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Item</h1>
          <p className="mt-2 text-gray-600">Update item details</p>
        </div>
        <Button type="button" variant="outline" onClick={handleDuplicate} disabled={duplicating}>
          <Copy className="mr-2 h-4 w-4" />
          {duplicating ? 'Duplicating...' : 'Duplicate'}
        </Button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Item name"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="sku">SKU</Label>
                    <Input
                      id="sku"
                      value={formData.sku}
                      onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                      placeholder="SKU code"
                    />
                  </div>
                  <div>
                    <Label htmlFor="type">Type *</Label>
                    <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value })}>
                      <SelectTrigger id="type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PRODUCT">Product</SelectItem>
                        <SelectItem value="SERVICE">Service</SelectItem>
                        <SelectItem value="MATERIAL">Material</SelectItem>
                        <SelectItem value="FEE">Fee</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label htmlFor="description">Description</Label>
                  <textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="categoryId">Category</Label>
                    <div className="flex space-x-2">
                      <div className="flex-1">
                        <Select
                          value={formData.categoryId || '__none__'}
                          onValueChange={(value) => setFormData({ ...formData, categoryId: value === '__none__' ? '' : value })}
                        >
                          <SelectTrigger id="categoryId">
                            <SelectValue placeholder="Select category" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Select category</SelectItem>
                            {categories.map((cat) => (
                              <SelectItem key={cat.id} value={cat.id}>
                                {cat.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {!showNewCategory && (
                        <Button type="button" variant="outline" onClick={() => setShowNewCategory(true)}>
                          <Plus className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {showNewCategory && (
                      <div className="mt-2 flex space-x-2">
                        <Input
                          placeholder="New category name"
                          value={newCategoryName}
                          onChange={(e) => setNewCategoryName(e.target.value)}
                          onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleCreateCategory())}
                        />
                        <Button type="button" onClick={handleCreateCategory}>
                          Add
                        </Button>
                        <Button type="button" variant="outline" onClick={() => { setShowNewCategory(false); setNewCategoryName('') }}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="vendorId">Default Vendor</Label>
                    <Select
                      value={formData.vendorId || '__none__'}
                      onValueChange={(value) => setFormData({ ...formData, vendorId: value === '__none__' ? '' : value })}
                    >
                      <SelectTrigger id="vendorId">
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select vendor</SelectItem>
                        {vendors.map((vendor) => (
                          <SelectItem key={vendor.id} value={vendor.id}>
                            {vendor.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label>Tags</Label>
                  <div className="flex space-x-2 mb-2">
                    <Input
                      placeholder="Add tag"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                    />
                    <Button type="button" onClick={addTag}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {tags.map((tag) => (
                        <span key={tag} className="px-2 py-1 bg-gray-100 rounded-md text-sm flex items-center">
                          {tag}
                          <button
                            type="button"
                            onClick={() => removeTag(tag)}
                            className="ml-2 text-gray-500 hover:text-gray-700"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Pricing */}
            <Card>
              <CardHeader>
                <CardTitle>Pricing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="unit">Unit</Label>
                    <Select value={formData.unit} onValueChange={(value) => setFormData({ ...formData, unit: value })}>
                      <SelectTrigger id="unit">
                        <SelectValue placeholder="Select unit" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ea">Each (ea)</SelectItem>
                        <SelectItem value="hr">Hour (hr)</SelectItem>
                        <SelectItem value="sqft">Square Foot (sqft)</SelectItem>
                        <SelectItem value="lnft">Linear Foot (lnft)</SelectItem>
                        <SelectItem value="lb">Pound (lb)</SelectItem>
                        <SelectItem value="gal">Gallon (gal)</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                    {formData.unit === 'custom' && (
                      <Input
                        className="mt-2"
                        placeholder="Enter custom unit"
                        value={formData.unit}
                        onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                      />
                    )}
                  </div>
                  <div>
                    <Label htmlFor="defaultUnitCost">Default Unit Cost</Label>
                    <Input
                      id="defaultUnitCost"
                      type="number"
                      step="0.01"
                      value={formData.defaultUnitCost}
                      onChange={(e) => setFormData({ ...formData, defaultUnitCost: e.target.value })}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="pricingMode">Price Type</Label>
                  <Select
                    value={formData.pricingMode}
                    onValueChange={(value) => setFormData({ ...formData, pricingMode: value as 'FIXED' | 'PERCENT_OF_ABOVE' })}
                  >
                    <SelectTrigger id="pricingMode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FIXED">Fixed amount</SelectItem>
                      <SelectItem value="PERCENT_OF_ABOVE">Calculate % of items above</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.pricingMode === 'PERCENT_OF_ABOVE' ? (
                  <div>
                    <Label htmlFor="percentOfAboveRate">Percentage *</Label>
                    <Input
                      id="percentOfAboveRate"
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={formData.percentOfAboveRate}
                      onChange={(e) => setFormData({ ...formData, percentOfAboveRate: e.target.value })}
                      placeholder="e.g. 10"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      When added to an estimate, invoice, or purchase order, this item's price is
                      calculated automatically as this percentage of the line items already listed
                      above it — like a reusable "10% Overhead" line.
                    </p>
                  </div>
                ) : (
                  <div>
                    <Label htmlFor="defaultUnitPrice">Default Unit Price *</Label>
                    <Input
                      id="defaultUnitPrice"
                      type="number"
                      step="0.01"
                      required
                      value={formData.defaultUnitPrice}
                      onChange={(e) => setFormData({ ...formData, defaultUnitPrice: e.target.value })}
                      placeholder="0.00"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Use a negative amount for credit-style items (reduces totals on estimates and invoices).
                    </p>
                    {formData.defaultUnitCost && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={calculatePriceFromCost}
                      >
                        Calculate from Cost (50% markup)
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Tax */}
            <Card>
              <CardHeader>
                <CardTitle>Tax Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="taxable"
                    checked={formData.taxable}
                    onChange={(e) => setFormData({ ...formData, taxable: e.target.checked })}
                    className="rounded"
                  />
                  <Label htmlFor="taxable">Taxable</Label>
                </div>
                {formData.taxable && (
                  <div>
                    <Label htmlFor="taxRate">Tax Rate Override (%)</Label>
                    <Input
                      id="taxRate"
                      type="number"
                      step="0.01"
                      value={formData.taxRate}
                      onChange={(e) => setFormData({ ...formData, taxRate: e.target.value })}
                      placeholder="Leave empty to use default"
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                  rows={4}
                  placeholder="Internal notes (not shown to clients)"
                />
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="rounded"
                  />
                  <Label htmlFor="isActive">Active</Label>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col space-y-2">
              <Button type="submit" disabled={saving} className="w-full">
                <Save className="mr-2 h-4 w-4" />
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="w-full">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
