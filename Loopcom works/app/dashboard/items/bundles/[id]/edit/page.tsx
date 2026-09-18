'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Save, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { FastPicker, FastPickerItem } from '@/components/items/FastPicker'

interface Vendor {
  id: string
  name: string
}

interface ItemCategory {
  id: string
  name: string
}

interface Item {
  id: string
  name: string
  sku: string | null
  kind: string
  defaultUnitPrice: number
  defaultUnitCost: number | null
  unit: string
}

interface Bundle {
  id: string
  name: string
  item: {
    id: string
    name: string
    defaultUnitPrice?: number | string | null
    defaultUnitCost?: number | string | null
  }
}

interface BundleComponent {
  id?: string
  componentType: 'ITEM' | 'BUNDLE'
  componentItemId?: string
  componentBundleId?: string
  quantity: string
  defaultUnitPriceOverride?: string // Customer Price
  defaultUnitCostOverride?: string // Vendor/Unit Cost
  vendorId?: string // Vendor Assignment
  notes?: string
}

const toNumber = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export default function EditBundlePage() {
  const router = useRouter()
  const params = useParams()
  const bundleId = params?.id as string | undefined

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [categories, setCategories] = useState<ItemCategory[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [components, setComponents] = useState<BundleComponent[]>([])
  const [componentPickerValue, setComponentPickerValue] = useState('')
  const [pricingStrategy, setPricingStrategy] = useState('SUM_COMPONENTS')
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    type: 'PRODUCT',
    description: '',
    categoryId: '',
    vendorId: '',
    tags: '',
    notes: '',
  })

  useEffect(() => {
    if (bundleId) {
      fetchBundle()
      fetchVendors()
      fetchCategories()
      fetchItems()
      fetchBundles()
    }
  }, [bundleId])

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

  const fetchItems = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items?kind=SINGLE&limit=1000', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setItems(data.items || [])
      }
    } catch (error) {
      console.error('Error fetching items:', error)
    }
  }

  const fetchBundles = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/bundles', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        // Filter out current bundle to prevent self-reference
        setBundles((data.bundles || []).filter((b: Bundle) => b.id !== bundleId))
      }
    } catch (error) {
      console.error('Error fetching bundles:', error)
    }
  }

  const fetchBundle = async () => {
    if (!bundleId) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items/bundles/${bundleId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to load bundle')
        router.push('/dashboard/items')
        return
      }

      const data = await response.json()
      const bundle = data.bundle

      setFormData({
        name: bundle.item.name,
        sku: bundle.item.sku || '',
        type: bundle.item.type,
        description: bundle.item.description || '',
        categoryId: bundle.item.categoryId || '',
        vendorId: bundle.item.vendorId || '',
        tags: bundle.item.tags?.join(', ') || '',
        notes: bundle.item.notes || '',
      })

      setPricingStrategy(bundle.pricingStrategy || 'SUM_COMPONENTS')
      setComponents(
        bundle.components.map((comp: any) => ({
          id: comp.id,
          componentType: comp.componentType,
          componentItemId: comp.componentItemId || undefined,
          componentBundleId: comp.componentBundleId || undefined,
          quantity: comp.quantity.toString(),
          defaultUnitPriceOverride: comp.defaultUnitPriceOverride?.toString() || undefined,
          defaultUnitCostOverride: comp.defaultUnitCostOverride?.toString() || undefined,
          vendorId: comp.vendorId || undefined,
          notes: comp.notes || undefined,
        }))
      )
    } catch (error) {
      console.error('Error fetching bundle:', error)
      alert('Failed to load bundle')
    } finally {
      setLoading(false)
    }
  }

  const addItemComponent = (itemId: string) => {
    setComponents((prev) => [
      ...prev,
      {
        componentType: 'ITEM',
        componentItemId: itemId,
        quantity: '1',
      },
    ])
  }

  const addBundleComponent = (bundleId: string) => {
    setComponents((prev) => [
      ...prev,
      {
        componentType: 'BUNDLE',
        componentBundleId: bundleId,
        quantity: '1',
      },
    ])
  }

  const removeComponent = (index: number) => {
    setComponents(components.filter((_, i) => i !== index))
  }

  const updateComponent = (index: number, field: keyof BundleComponent, value: string) => {
    const updated = [...components]
    updated[index] = { ...updated[index], [field]: value }
    setComponents(updated)
  }

  const calculateTotals = () => {
    let totalCost = 0
    let totalPrice = 0

    for (const comp of components) {
      const qty = parseFloat(comp.quantity) || 0
      if (comp.componentType === 'ITEM') {
        const item = items.find((i) => i.id === comp.componentItemId)
        if (item) {
          const price = comp.defaultUnitPriceOverride
            ? parseFloat(comp.defaultUnitPriceOverride)
            : toNumber(item.defaultUnitPrice)
          const cost = comp.defaultUnitCostOverride
            ? parseFloat(comp.defaultUnitCostOverride)
            : toNumber(item.defaultUnitCost)
          totalPrice += price * qty
          totalCost += cost * qty
        }
      } else if (comp.componentType === 'BUNDLE') {
        const bundle = bundles.find((b) => b.id === comp.componentBundleId)
        if (bundle) {
          const basePrice = toNumber(bundle.item?.defaultUnitPrice)
          const baseCost = toNumber(bundle.item?.defaultUnitCost)
          const price = comp.defaultUnitPriceOverride
            ? parseFloat(comp.defaultUnitPriceOverride)
            : basePrice
          const cost = comp.defaultUnitCostOverride
            ? parseFloat(comp.defaultUnitCostOverride)
            : baseCost
          totalPrice += price * qty
          totalCost += cost * qty
        }
      }
    }

    return { totalCost, totalPrice }
  }

  const totals = calculateTotals()

  const pickerItems = useMemo<FastPickerItem[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        kind: 'SINGLE',
        defaultUnitPrice: toNumber(item.defaultUnitPrice),
        defaultUnitCost: item.defaultUnitCost != null ? toNumber(item.defaultUnitCost) : null,
        unit: item.unit || 'ea',
        vendorId: null,
        vendorName: null,
        taxable: true,
        taxRate: null,
        notes: null,
      })),
    [items]
  )

  const pickerBundles = useMemo<FastPickerItem[]>(
    () =>
      bundles.map((bundle) => ({
        id: bundle.id,
        name: bundle.name,
        sku: null,
        kind: 'BUNDLE',
        defaultUnitPrice: 0,
        defaultUnitCost: null,
        unit: 'bundle',
        vendorId: null,
        vendorName: null,
        taxable: false,
        taxRate: null,
        notes: null,
        bundleId: bundle.id,
      })),
    [bundles]
  )

  const handlePickerSelect = (selected: FastPickerItem) => {
    if (selected.kind === 'BUNDLE') {
      addBundleComponent(selected.bundleId || selected.id)
    } else {
      addItemComponent(selected.id)
    }
    setComponentPickerValue('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)

    if (components.length === 0) {
      alert('Bundle must have at least one component')
      setSaving(false)
      return
    }

    try {
      const token = localStorage.getItem('accessToken')
      const tagsArray = formData.tags
        ? formData.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []

      const response = await fetch(`/api/items/bundles/${bundleId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          categoryId: formData.categoryId || null,
          vendorId: formData.vendorId || null,
          tags: tagsArray,
          pricingStrategy,
          components: components.map((comp) => ({
            componentType: comp.componentType,
            componentItemId: comp.componentItemId || null,
            componentBundleId: comp.componentBundleId || null,
            quantity: parseFloat(comp.quantity) || 1,
            defaultUnitPriceOverride: comp.defaultUnitPriceOverride || null,
            defaultUnitCostOverride: comp.defaultUnitCostOverride || null,
            vendorId: comp.vendorId || null,
            notes: comp.notes || null,
          })),
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to update bundle')
        setSaving(false)
        return
      }

      const data = await response.json()
      if (!data.bundle || !data.bundle.id) {
        console.error('Invalid response data:', data)
        alert('Bundle updated but invalid response received')
        setSaving(false)
        return
      }
      router.replace(`/dashboard/items/${data.bundle.item.id}`)
    } catch (error) {
      console.error('Error updating bundle:', error)
      alert('Failed to update bundle. Check console for details.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading bundle...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Bundle</h1>
          <p className="mt-2 text-gray-600">Update bundle details</p>
        </div>
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
                    placeholder="Bundle name"
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
                  <Label>Tags (comma-separated)</Label>
                  <Input
                    placeholder="tag1, tag2, tag3"
                    value={formData.tags}
                    onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Bundle Contents */}
            <Card>
              <CardHeader>
                <CardTitle>Bundle Contents *</CardTitle>
                <CardDescription>Add items or other bundles to this bundle</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-sm">Add Component</Label>
                  <FastPicker
                    value={componentPickerValue}
                    onChange={setComponentPickerValue}
                    onSelect={handlePickerSelect}
                    items={pickerItems}
                    bundles={pickerBundles}
                    placeholder="Type to search items/bundles and press Enter"
                    className="mt-1"
                  />
                </div>

                {components.length === 0 ? (
                  <div className="text-center py-6 text-sm text-gray-500">
                    No components added yet
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="hidden md:grid md:grid-cols-12 gap-2 px-2 text-xs text-gray-500">
                      <div className="md:col-span-3">Component</div>
                      <div className="md:col-span-1">Qty</div>
                      <div className="md:col-span-3">Vendor</div>
                      <div className="md:col-span-2">Unit Cost</div>
                      <div className="md:col-span-2">Custom Price</div>
                      <div className="md:col-span-1 text-right">Action</div>
                    </div>
                    {components.map((comp, index) => {
                      const item = comp.componentType === 'ITEM'
                        ? items.find((i) => i.id === comp.componentItemId)
                        : null
                      const bundle = comp.componentType === 'BUNDLE'
                        ? bundles.find((b) => b.id === comp.componentBundleId)
                        : null

                      return (
                        <div key={index} className="border rounded-md p-2">
                          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
                            <div className="md:col-span-3">
                              <div className="text-sm font-medium truncate">
                                {comp.componentType === 'ITEM' ? item?.name : bundle?.name}
                              </div>
                              <div className="text-xs text-gray-500">
                                {comp.componentType === 'ITEM' ? 'Item' : 'Bundle'}
                              </div>
                            </div>
                            <div className="md:col-span-1">
                              <Input
                                type="number"
                                step="0.01"
                                value={comp.quantity}
                                onChange={(e) => updateComponent(index, 'quantity', e.target.value)}
                                required
                                className="h-9 text-sm"
                              />
                            </div>
                            <div className="md:col-span-3">
                              <Select
                                value={comp.vendorId || '__none__'}
                                onValueChange={(value) => updateComponent(index, 'vendorId', value === '__none__' ? '' : value)}
                              >
                                <SelectTrigger className="h-9 text-sm">
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
                            <div className="md:col-span-2">
                              <Input
                                type="number"
                                step="0.01"
                                value={comp.defaultUnitCostOverride || ''}
                                onChange={(e) => updateComponent(index, 'defaultUnitCostOverride', e.target.value)}
                                placeholder={comp.componentType === 'ITEM' && item ? `${toNumber(item.defaultUnitCost).toFixed(2)}` : 'Auto'}
                                className="h-9 text-sm"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <Input
                                type="number"
                                step="0.01"
                                value={comp.defaultUnitPriceOverride || ''}
                                onChange={(e) => updateComponent(index, 'defaultUnitPriceOverride', e.target.value)}
                                placeholder={comp.componentType === 'ITEM' && item ? `${toNumber(item.defaultUnitPrice).toFixed(2)}` : 'Auto'}
                                className="h-9 text-sm"
                              />
                            </div>
                            <div className="md:col-span-1 flex md:justify-end">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeComponent(index)}
                                className="h-9 w-9 p-0"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Totals */}
                {components.length > 0 && (
                  <div className="border-t pt-4 mt-4">
                    <div className="flex justify-between items-center">
                      <span className="font-medium">Bundle Total:</span>
                      <div className="text-right">
                        <div className="text-sm text-gray-600">
                          Cost: {totals.totalCost > 0 ? `$${totals.totalCost.toFixed(2)}` : 'N/A'}
                        </div>
                        <div className="text-lg font-semibold">
                          Price: ${totals.totalPrice.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pricing Strategy */}
            <Card>
              <CardHeader>
                <CardTitle>Pricing Strategy</CardTitle>
              </CardHeader>
              <CardContent>
                <div>
                  <Label htmlFor="pricingStrategy">Pricing Method</Label>
                  <Select value={pricingStrategy} onValueChange={setPricingStrategy}>
                    <SelectTrigger id="pricingStrategy">
                      <SelectValue placeholder="Select pricing method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SUM_COMPONENTS">Sum of Components (Default)</SelectItem>
                      <SelectItem value="OVERRIDE_PRICE">Override Bundle Price</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-2 text-sm text-gray-600">
                    {pricingStrategy === 'SUM_COMPONENTS'
                      ? 'Bundle price will be calculated from component prices'
                      : 'You can set a custom bundle price independent of components'}
                  </p>
                </div>
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
                  placeholder="Internal notes"
                />
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="flex flex-col space-y-2">
              <Button type="submit" disabled={saving || components.length === 0} className="w-full">
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
