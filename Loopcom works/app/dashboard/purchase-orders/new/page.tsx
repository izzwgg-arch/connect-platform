'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableJobSelect } from '@/components/ui/searchable-job-select'
import { Save, Plus, Trash2, Eye, EyeOff, MessageSquare } from 'lucide-react'
import Link from 'next/link'
import { LineItemDragHandle } from '@/components/documents/line-item-drag-handle'
import { FastPicker, FastPickerItem } from '@/components/items/FastPicker'
import { computePercentOfAbovePrice } from '@/lib/documents/percent-of-above'
import {
  catalogNotesFromItem,
  expandBundleComponentsToLineItems,
  bundleExpandedLineToPurchaseOrderLine,
} from '@/lib/bundles/expand-line-items'
import { formatAddressParts } from '@/lib/address/parse'
interface Vendor {
  id: string
  name: string
  email: string | null
  phone: string | null
  contactPerson: string | null
}

interface Job {
  id: string
  jobNumber: string
  title: string
  status?: string | null
  client?: { id?: string; name?: string | null; companyName?: string | null } | null
  addresses?: Array<{
    street?: string | null
    city?: string | null
    state?: string | null
    zipCode?: string | null
  }> | null
}

interface LineItem {
  id?: string
  description: string
  details?: string
  quantity: string
  unitCost: string // Primary field for POs
  unitPrice?: string // Optional, for reference
  notes?: string
  vendorId?: string | null
  vendorName?: string | null
  // Bundle support
  groupId?: string
  groupName?: string
  isGroupHeader?: boolean
  sourceItemId?: string | null
  sourceBundleId?: string | null
  tag?: string
  // Free-text note row between line items — no qty/price
  isNote?: boolean
  // Vendor-facing visibility (PDF) — same pattern as estimates
  isVisibleToClient?: boolean
  showDescriptionToCustomer?: boolean
  showDetailsToCustomer?: boolean
  showNotesToCustomer?: boolean
  showPriceToCustomer?: boolean
}

const defaultPoVisibility = {
  isVisibleToClient: true,
  showDescriptionToCustomer: true,
  showDetailsToCustomer: true,
  showNotesToCustomer: true,
  showPriceToCustomer: true,
}

export default function NewPurchaseOrderPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobIdParam = searchParams.get('jobId')
  
  const [loading, setLoading] = useState(false)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [pickerItems, setPickerItems] = useState<FastPickerItem[]>([])
  const [pickerBundles, setPickerBundles] = useState<FastPickerItem[]>([])
  const [lineItems, setLineItems] = useState<LineItem[]>([
    {
      description: '',
      quantity: '1',
      unitCost: '0',
      ...defaultPoVisibility,
    },
  ])
  
  const [formData, setFormData] = useState({
    vendorId: '',
    jobId: jobIdParam || '',
    poNumber: '',
    status: 'DRAFT',
    expectedDate: '',
    orderDate: new Date().toISOString().split('T')[0],
    notes: '',
    internalNotes: '',
    deliveryAddress: '',
    tax: '0',
    shipping: '0',
  })

  const lineItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const pickerInputRefs = useRef<(HTMLInputElement | null)[]>([])

  const loadNextPoNumber = useCallback(async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/purchase-orders/next-number', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const data = await response.json()
      if (typeof data.poNumber === 'string' && data.poNumber) {
        setFormData((prev) => (prev.poNumber.trim() ? prev : { ...prev, poNumber: data.poNumber }))
      }
    } catch (error) {
      console.error('Error loading next PO number:', error)
    }
  }, [])

  useEffect(() => {
    fetchVendors()
    fetchJobs()
    fetchPickerData()
    loadNextPoNumber()
  }, [loadNextPoNumber])
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

  const fetchJobs = async (search = '') => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({ limit: '100' })
      if (search.trim()) params.set('search', search.trim())
      const response = await fetch(`/api/jobs?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        const nextJobs: Job[] = data.jobs || []
        setJobs((prev) => {
          const selected = prev.find((job) => job.id === formData.jobId)
          if (!selected || nextJobs.some((job) => job.id === selected.id)) return nextJobs
          return [selected, ...nextJobs]
        })
      }
    } catch (error) {
      console.error('Error fetching jobs:', error)
    }
  }

  const fetchPickerData = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/items/picker', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setPickerItems(data.items || [])
        setPickerBundles(data.bundles || [])
      }
    } catch (error) {
      console.error('Error fetching items for picker:', error)
    }
  }

  const jobSiteAddressFor = (job?: Job | null) =>
    formatAddressParts(job?.addresses?.[0] || null) || ''

  const handleJobSelect = (jobId: string) => {
    if (!jobId) {
      setFormData((prev) => ({ ...prev, jobId: '' }))
      return
    }
    const job = jobs.find((j) => j.id === jobId) || null
    const site = jobSiteAddressFor(job)
    setFormData((prev) => ({
      ...prev,
      jobId,
      // Default delivery address from the selected job site; user can still edit.
      deliveryAddress: site || prev.deliveryAddress,
    }))
  }

  // Prefill delivery address when jobs load and a job is already selected (e.g. ?jobId=).
  useEffect(() => {
    if (!formData.jobId || formData.deliveryAddress.trim()) return
    const job = jobs.find((j) => j.id === formData.jobId)
    const site = jobSiteAddressFor(job)
    if (site) {
      setFormData((prev) => (prev.deliveryAddress.trim() ? prev : { ...prev, deliveryAddress: site }))
    }
  }, [jobs, formData.jobId, formData.deliveryAddress])

  const addLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      {
        description: '',
        quantity: '1',
        unitCost: '0',
        ...defaultPoVisibility,
      },
    ])
  }

  const addNoteItem = () => {
    setLineItems((prev) => [
      ...prev,
      {
        description: '',
        quantity: '0',
        unitCost: '0',
        isNote: true,
        ...defaultPoVisibility,
      },
    ])
  }

  const insertLineItemAfter = (index: number) => {
    setLineItems((prev) => {
      const row = prev[index]
      const next = [...prev]
      const blank: LineItem = {
        description: '',
        quantity: '1',
        unitCost: '0',
        ...defaultPoVisibility,
      }
      if (row.groupId) {
        blank.groupId = row.groupId
        blank.groupName = row.groupName
      }
      next.splice(index + 1, 0, blank)
      return next
    })
  }

  const insertNoteAfter = (index: number) => {
    setLineItems((prev) => {
      const next = [...prev]
      const blank: LineItem = {
        description: '',
        quantity: '0',
        unitCost: '0',
        isNote: true,
        ...defaultPoVisibility,
      }
      next.splice(index + 1, 0, blank)
      return next
    })
  }

  const removeLineItem = (index: number) => {
    setLineItems((prev) => {
      if (prev.length <= 1) return prev
      const item = prev[index]
      if (item?.groupId && item.isGroupHeader) {
        return prev.filter((li, i) => li.groupId !== item.groupId || i === index)
      }
      return prev.filter((_, i) => i !== index)
    })
  }

  const updateLineItem = (index: number, field: keyof LineItem, value: any) => {
    setLineItems((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  const toggleVisibility = (
    index: number,
    field: 'description' | 'details' | 'notes' | 'price'
  ) => {
    const fieldMap = {
      description: 'showDescriptionToCustomer',
      details: 'showDetailsToCustomer',
      notes: 'showNotesToCustomer',
      price: 'showPriceToCustomer',
    } as const
    setLineItems((prev) => {
      const updated = [...prev]
      const key = fieldMap[field]
      updated[index] = {
        ...updated[index],
        [key]: updated[index][key] === false ? true : false,
      }
      return updated
    })
  }

  const toggleLineRowVisibility = (index: number) => {
    setLineItems((prev) => {
      const updated = [...prev]
      updated[index] = {
        ...updated[index],
        isVisibleToClient: updated[index].isVisibleToClient === false ? true : false,
      }
      return updated
    })
  }

  const setGroupLineItemsVisibility = (groupId: string, isVisibleToClient: boolean) => {
    setLineItems((prev) =>
      prev.map((item) =>
        item.groupId === groupId && !item.isGroupHeader ? { ...item, isVisibleToClient } : item
      )
    )
  }

  const reorderLineItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    setLineItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }

  const maybeAutoScrollDuringDrag = (clientY: number) => {
    const edge = 120
    const step = 26
    if (clientY > window.innerHeight - edge) {
      window.scrollBy({ top: step, behavior: 'auto' })
    } else if (clientY < edge) {
      window.scrollBy({ top: -step, behavior: 'auto' })
    }
  }

  const handleItemSelect = async (item: FastPickerItem, lineIndex: number) => {
    const updated = [...lineItems]

    if (item.kind === 'BUNDLE') {
      try {
        const token = localStorage.getItem('accessToken')
        const bundleDefId = item.bundleId || item.id
        
        const response = await fetch(`/api/items/bundles/${bundleDefId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        
        if (response.ok) {
          const bundleData = await response.json()
          const bundle = bundleData.bundle
          const components = bundle?.components || []
          
          const groupId = `group-${Date.now()}`
          updated[lineIndex] = {
            ...updated[lineIndex],
            description: bundle?.name || item.name,
            quantity: '1',
            unitCost: '0',
            groupId,
            groupName: bundle?.name || item.name,
            isGroupHeader: true,
            sourceBundleId: bundleDefId,
          }

          const expanded = await expandBundleComponentsToLineItems(
            components,
            groupId,
            token || ''
          )
          const childLines: LineItem[] = expanded.map((line) =>
            bundleExpandedLineToPurchaseOrderLine(line, {
              vendorId: item.vendorId,
              vendorName: item.vendorName,
              sourceBundleId: bundleDefId,
            })
          )

          updated.splice(lineIndex + 1, 0, ...childLines)
        } else {
          updated[lineIndex] = {
            ...updated[lineIndex],
            description: item.name,
            quantity: '1',
            unitCost: item.defaultUnitCost?.toString() || '0',
            unitPrice: item.defaultUnitPrice.toString(),
            details: catalogNotesFromItem(item),
            notes: '',
            vendorId: item.vendorId || null,
            vendorName: item.vendorName || null,
            sourceBundleId: bundleDefId,
            tag: item.tag || '',
          }
        }
      } catch (error) {
        console.error('Error fetching bundle details:', error)
        updated[lineIndex] = {
          ...updated[lineIndex],
          description: item.name,
          quantity: '1',
          unitCost: item.defaultUnitCost?.toString() || '0',
          unitPrice: item.defaultUnitPrice.toString(),
          details: catalogNotesFromItem(item),
          notes: '',
          vendorId: item.vendorId || null,
          vendorName: item.vendorName || null,
          sourceBundleId: item.bundleId || undefined,
          tag: item.tag || '',
        }
      }
    } else {
      // POs charge off unitCost, not unitPrice — sum the preceding lines' cost total.
      const computedCost =
        item.pricingMode === 'PERCENT_OF_ABOVE'
          ? computePercentOfAbovePrice(
              lineItems.slice(0, lineIndex).map((li) => ({ quantity: li.quantity, unitPrice: li.unitCost, isNote: li.isNote, isGroupHeader: li.isGroupHeader })),
              item.percentOfAboveRate || 0
            )
          : null
      updated[lineIndex] = {
        ...updated[lineIndex],
        description: item.name,
        quantity: '1',
        unitCost: computedCost != null ? computedCost.toString() : item.defaultUnitCost?.toString() || '0',
        unitPrice: computedCost != null ? computedCost.toString() : item.defaultUnitPrice.toString(),
        details: catalogNotesFromItem(item),
        notes: '',
        vendorId: item.vendorId || null,
        vendorName: item.vendorName || null,
        sourceItemId: item.id,
        tag: item.tag || '',
      }
    }

    setLineItems(updated)
    
    // Return a promise that resolves after state update
    // Use requestAnimationFrame to ensure React has processed the state update
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          resolve()
        }, 0)
      })
    })
  }

  const handleNextLine = (currentIndex: number) => {
    const nextIndex = currentIndex + 1
    setLineItems((prev) => {
      if (nextIndex < prev.length) return prev
      return [
        ...prev,
        {
          description: '',
          quantity: '1',
          unitCost: '0',
          ...defaultPoVisibility,
        },
      ]
    })
    setTimeout(() => {
      const nextInput = pickerInputRefs.current[nextIndex]
      if (nextInput) {
        nextInput.focus()
        nextInput.dispatchEvent(new Event('focus', { bubbles: true }))
      } else {
        const nextContainer = lineItemRefs.current[nextIndex]
        const fallbackInput = nextContainer?.querySelector<HTMLInputElement>('[data-picker-input="true"]')
        if (fallbackInput) {
          fallbackInput.focus()
          fallbackInput.dispatchEvent(new Event('focus', { bubbles: true }))
        }
      }
    }, 100)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.vendorId) {
      alert('Please select a vendor')
      return
    }

    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      
      const subtotal = lineItems.reduce((sum, item) => {
        if (item.isGroupHeader || item.isNote) return sum
        return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitCost || '0')
      }, 0)

      const tax = parseFloat(formData.tax || '0')
      const shipping = parseFloat(formData.shipping || '0')
      const total = subtotal + tax + shipping

      const apiLineItems = lineItems
        .filter(item => !item.isGroupHeader)
        .map((item, index) => ({
          description: item.description,
          quantity: item.isNote ? 0 : parseFloat(item.quantity || '1'),
          unitPrice: item.isNote ? 0 : parseFloat(item.unitCost || '0'), // PO uses unitPrice field for cost
          unitCost: item.isNote ? 0 : parseFloat(item.unitCost || '0'),
          total: item.isNote ? 0 : parseFloat(item.quantity || '1') * parseFloat(item.unitCost || '0'),
          sortOrder: index,
          vendorId: item.vendorId || null,
          details: item.details || null,
          notes: item.notes || null,
          groupId: item.groupId || null,
          sourceItemId: item.sourceItemId || null,
          sourceBundleId: item.sourceBundleId || null,
          isNote: item.isNote === true,
          isVisibleToClient: item.isVisibleToClient !== false,
          showDescriptionToCustomer: item.showDescriptionToCustomer !== false,
          showDetailsToCustomer: item.showDetailsToCustomer !== false,
          showNotesToCustomer: item.showNotesToCustomer !== false,
          showPriceToCustomer: item.showPriceToCustomer !== false,
        }))

      const groups = new Map<string, { name: string; sourceBundleId?: string }>()
      lineItems.forEach(item => {
        if (item.groupId && item.groupName && !groups.has(item.groupId)) {
          groups.set(item.groupId, {
            name: item.groupName,
            sourceBundleId: item.sourceBundleId || undefined,
          })
        }
      })

      const response = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          vendorId: formData.vendorId,
          poNumber: formData.poNumber || null,
          jobId: formData.jobId || null,
          status: formData.status,
          expectedDate: formData.expectedDate || null,
          orderDate: formData.orderDate || new Date().toISOString().split('T')[0],
          notes: formData.notes || null,
          internalNotes: formData.internalNotes || null,
          deliveryAddress: formData.deliveryAddress || null,
          tax,
          shipping,
          total,
          lineItems: apiLineItems,
          groups: Array.from(groups.entries()).map(([groupId, group]) => ({
            groupId,
            ...group,
          })),
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to create purchase order' }))
        alert(errorData.error || 'Failed to create purchase order')
        return
      }

      const data = await response.json()
      router.push(`/dashboard/purchase-orders/${data.purchaseOrder.id}`)
    } catch (error) {
      console.error('Error creating purchase order:', error)
      alert('Failed to create purchase order. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const subtotal = lineItems.reduce((sum, item) => {
    if (item.isGroupHeader || item.isNote) return sum
    return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitCost || '0')
  }, 0)
  
  const tax = parseFloat(formData.tax || '0')
  const shipping = parseFloat(formData.shipping || '0')
  const total = subtotal + tax + shipping

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref="/dashboard/purchase-orders" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">New Purchase Order</h1>
          <p className="mt-2 text-gray-600">Create a new purchase order for a vendor</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Purchase Order Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="poNumber">PO #</Label>
                  <Input
                    id="poNumber"
                    value={formData.poNumber}
                    onChange={(e) => setFormData({ ...formData, poNumber: e.target.value })}
                    placeholder="ex: PO-000123"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Prefills with the next number. You can change it; future POs continue from the highest used number.
                  </p>
                </div>
                <div>
                  <Label htmlFor="vendorId">Vendor *</Label>
                  <Select
                    value={formData.vendorId}
                    onValueChange={(value) => setFormData({ ...formData, vendorId: value })}
                  >
                    <SelectTrigger id="vendorId">
                      <SelectValue placeholder="Select a vendor..." />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((vendor) => (
                        <SelectItem key={vendor.id} value={vendor.id}>
                          {vendor.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="jobId">Job (Optional)</Label>
                  <SearchableJobSelect
                    jobs={jobs}
                    value={formData.jobId || ''}
                    onSelect={handleJobSelect}
                    onSearch={fetchJobs}
                    placeholder="Search jobs by number, title, or client..."
                    allowNone
                    noneLabel="No job"
                  />
                </div>
                <div>
                  <Label htmlFor="deliveryAddress">Delivery Address</Label>
                  <textarea
                    id="deliveryAddress"
                    value={formData.deliveryAddress}
                    onChange={(e) => setFormData({ ...formData, deliveryAddress: e.target.value })}
                    placeholder="Defaults from job site address — editable"
                    rows={3}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Shown to the vendor on the PO / PDF.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="orderDate">Order Date *</Label>
                    <Input
                      id="orderDate"
                      type="date"
                      required
                      value={formData.orderDate}
                      onChange={(e) => setFormData({ ...formData, orderDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="expectedDate">Expected Delivery Date</Label>
                    <Input
                      id="expectedDate"
                      type="date"
                      value={formData.expectedDate}
                      onChange={(e) => setFormData({ ...formData, expectedDate: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value) => setFormData({ ...formData, status: value })}
                  >
                    <SelectTrigger id="status">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="PENDING_APPROVAL">Pending Approval</SelectItem>
                      <SelectItem value="APPROVED">Approved</SelectItem>
                      <SelectItem value="ORDERED">Ordered</SelectItem>
                      <SelectItem value="RECEIVED">Received</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="notes">Notes to Vendor</Label>
                  <textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    placeholder="Visible to vendor on PO / email / PDF"
                    rows={3}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
                  />
                </div>
                <div>
                  <Label htmlFor="internalNotes">Internal Notes</Label>
                  <textarea
                    id="internalNotes"
                    value={formData.internalNotes}
                    onChange={(e) => setFormData({ ...formData, internalNotes: e.target.value })}
                    placeholder="Staff only — not visible to vendor"
                    rows={3}
                    className="flex w-full rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
                  />
                  <p className="mt-1 text-xs text-amber-800">
                    Never included on vendor PDF or email.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Line Items</CardTitle>
                <CardDescription>Click in Item to search and add catalog products. Focus on vendor costs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-2">
                  {lineItems.map((item, index) => {
                    const isGroupHeader = item.isGroupHeader
                    const isInGroup = !!item.groupId && !isGroupHeader
                    
                    return (
                      <div
                        key={index}
                        ref={(el) => {
                          lineItemRefs.current[index] = el
                        }}
                        data-line-item-row={index}
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          maybeAutoScrollDuringDrag(e.clientY)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          const from = parseInt(e.dataTransfer.getData('text/line-index'), 10)
                          if (!Number.isFinite(from)) return
                          reorderLineItems(from, index)
                        }}
                        className={`flex flex-wrap items-start gap-2 p-2 rounded border ${
                          isGroupHeader
                            ? 'bg-purple-50 border-purple-200'
                            : item.isNote
                            ? 'bg-amber-50 border-amber-200'
                            : isInGroup
                            ? 'bg-purple-25 border-purple-100 ml-4'
                            : 'border-gray-300'
                        } ${!isGroupHeader && item.isVisibleToClient === false ? 'opacity-50 bg-gray-50' : ''}`}
                      >
                        <div className="flex flex-col gap-1 items-center shrink-0 self-center">
                          <LineItemDragHandle transferKey="text/line-index" index={index} />
                          {!isGroupHeader && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleLineRowVisibility(index)}
                              title={
                                item.isVisibleToClient !== false
                                  ? 'Hide entire line from vendor PDF'
                                  : 'Show line on vendor PDF'
                              }
                              className="p-1 h-6"
                            >
                              {item.isVisibleToClient !== false ? (
                                <Eye className="h-3 w-3 text-gray-600" />
                              ) : (
                                <EyeOff className="h-3 w-3 text-gray-400" />
                              )}
                            </Button>
                          )}
                        </div>
                        {isGroupHeader ? (
                          <div className="flex flex-1 min-w-0 items-center gap-2">
                            <Input
                              value={item.description}
                              onChange={(e) => updateLineItem(index, 'description', e.target.value)}
                              placeholder="Bundle name"
                              className="flex-1 font-semibold"
                              readOnly
                            />
                            <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded">
                              Bundle
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setGroupLineItemsVisibility(
                                  item.groupId || '',
                                  lineItems.some(
                                    (li) =>
                                      li.groupId === item.groupId &&
                                      !li.isGroupHeader &&
                                      li.isVisibleToClient === false
                                  )
                                )
                              }
                              title="Show or hide this whole bundle on the vendor PDF"
                              className="p-1 h-7"
                            >
                              {lineItems.some(
                                (li) =>
                                  li.groupId === item.groupId &&
                                  !li.isGroupHeader &&
                                  li.isVisibleToClient === false
                              ) ? (
                                <EyeOff className="h-4 w-4 text-gray-400" />
                              ) : (
                                <Eye className="h-4 w-4 text-gray-600" />
                              )}
                            </Button>
                          </div>
                        ) : item.isNote ? (
                          <div className="flex-1 min-w-0">
                            <Label className="text-xs text-amber-600 font-medium mb-1 block">Note</Label>
                            <textarea
                              value={item.description}
                              onChange={(e) => updateLineItem(index, 'description', e.target.value)}
                              placeholder="Write a note for this section (not a priced item)..."
                              rows={2}
                              className="w-full rounded border border-amber-200 bg-white px-3 py-2 text-sm italic text-gray-700 focus:outline-none focus:ring-2 focus:ring-amber-300"
                            />
                          </div>
                        ) : (
                          <>
                            <div className="min-w-[160px] flex-[1.2]">
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Item</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'description')}
                                  title={
                                    item.showDescriptionToCustomer !== false
                                      ? 'Hide item from vendor PDF'
                                      : 'Show item on vendor PDF'
                                  }
                                  className="p-0.5 h-5 w-5"
                                >
                                  {item.showDescriptionToCustomer !== false ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <FastPicker
                                value={item.description}
                                onChange={(value) => updateLineItem(index, 'description', value)}
                                onSelect={(selectedItem) => handleItemSelect(selectedItem, index)}
                                onNextLine={() => handleNextLine(index)}
                                items={pickerItems}
                                bundles={pickerBundles}
                                placeholder="Type to search items..."
                                className="w-full"
                                showTagColumn
                                inputRef={(el) => {
                                  pickerInputRefs.current[index] = el
                                }}
                              />
                            </div>
                            <div className="min-w-[140px] flex-1">
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Description</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'details')}
                                  title={
                                    item.showDetailsToCustomer !== false
                                      ? 'Hide description from vendor PDF'
                                      : 'Show description on vendor PDF'
                                  }
                                  className="p-0.5 h-5 w-5"
                                >
                                  {item.showDetailsToCustomer !== false ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <Input
                                value={item.details || ''}
                                onChange={(e) => updateLineItem(index, 'details', e.target.value)}
                                placeholder="Description"
                              />
                            </div>
                            <div className="min-w-[120px] flex-1">
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Special notes</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'notes')}
                                  title={
                                    item.showNotesToCustomer !== false
                                      ? 'Hide special notes from vendor PDF'
                                      : 'Show special notes on vendor PDF'
                                  }
                                  className="p-0.5 h-5 w-5"
                                >
                                  {item.showNotesToCustomer !== false ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <Input
                                value={item.notes || ''}
                                onChange={(e) => updateLineItem(index, 'notes', e.target.value)}
                                placeholder="Special notes"
                              />
                            </div>
                            <div className="w-20 shrink-0">
                              <Label className="text-xs text-gray-500 mb-1 block">Qty</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="Qty"
                                value={item.quantity}
                                onChange={(e) => updateLineItem(index, 'quantity', e.target.value)}
                                required
                              />
                            </div>
                            <div className="w-28 shrink-0">
                              <Label className="text-xs text-gray-500 mb-1 block">Tag</Label>
                              <Input
                                value={item.tag || ''}
                                placeholder="-"
                                className="bg-white text-gray-700"
                                onChange={(e) => updateLineItem(index, 'tag', e.target.value)}
                              />
                            </div>
                            <div className="w-28 shrink-0">
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Vendor Cost *</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'price')}
                                  title={
                                    item.showPriceToCustomer !== false
                                      ? 'Hide price from vendor PDF'
                                      : 'Show price on vendor PDF'
                                  }
                                  className="p-0.5 h-5 w-5"
                                >
                                  {item.showPriceToCustomer !== false ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                value={item.unitCost}
                                onChange={(e) => updateLineItem(index, 'unitCost', e.target.value)}
                                required
                                className="font-semibold"
                              />
                            </div>
                            <div className="w-24 shrink-0">
                              <Label className="text-xs text-gray-500 mb-1 block">Total</Label>
                              <div className="flex h-10 items-center rounded-md border border-transparent px-3 text-sm font-semibold text-gray-900">
                                ${((parseFloat(item.quantity || '0') || 0) * (parseFloat(item.unitCost || '0') || 0)).toFixed(2)}
                              </div>
                            </div>
                            {item.unitPrice && parseFloat(item.unitPrice) > 0 && (
                              <div className="w-24 shrink-0">
                                <Label className="text-xs text-gray-400 mb-1 block">Sale Price</Label>
                                <Input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  placeholder="0.00"
                                  value={item.unitPrice}
                                  onChange={(e) => updateLineItem(index, 'unitPrice', e.target.value)}
                                  className="bg-gray-50 text-gray-500"
                                  readOnly
                                />
                              </div>
                            )}
                          </>
                        )}

                        {!isGroupHeader && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Insert line below"
                            className="shrink-0 self-center text-green-600 hover:text-green-800"
                            onClick={() => insertLineItemAfter(index)}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        )}

                        {!isGroupHeader && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Insert note below"
                            className="shrink-0 self-center text-amber-600 hover:text-amber-800"
                            onClick={() => insertNoteAfter(index)}
                          >
                            <MessageSquare className="h-4 w-4" />
                          </Button>
                        )}

                        {lineItems.length > 1 && !isGroupHeader && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0 self-center"
                            onClick={() => {
                              if (item.groupId) {
                                setLineItems(lineItems.filter((li, i) => li.groupId !== item.groupId || i === index))
                              } else {
                                removeLineItem(index)
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={addLineItem}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Line Item
                  </Button>
                  <Button type="button" variant="outline" onClick={addNoteItem} className="text-amber-700 border-amber-300 hover:bg-amber-50">
                    <MessageSquare className="mr-2 h-4 w-4" />
                    Add Note
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>${subtotal.toFixed(2)}</span>
                </div>
                <div>
                  <Label htmlFor="tax">Tax ($)</Label>
                  <Input
                    id="tax"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.tax}
                    onChange={(e) => setFormData({ ...formData, tax: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="shipping">Shipping/Fees ($)</Label>
                  <Input
                    id="shipping"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.shipping}
                    onChange={(e) => setFormData({ ...formData, shipping: e.target.value })}
                  />
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total:</span>
                  <span>${total.toFixed(2)}</span>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col space-y-2">
              <Button type="submit" disabled={loading} className="w-full">
                <Save className="mr-2 h-4 w-4" />
                {loading ? 'Creating...' : 'Create Purchase Order'}
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
