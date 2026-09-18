'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, Plus, Trash2, Eye, EyeOff, Copy, Building2, User } from 'lucide-react'
import { LineItemDragHandle } from '@/components/documents/line-item-drag-handle'
import Link from 'next/link'
import { FastPicker, FastPickerItem } from '@/components/items/FastPicker'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { computePercentOfAbovePrice } from '@/lib/documents/percent-of-above'
import { cnCustomerVisibilityBulkPill } from '@/lib/ui/customer-visibility-bulk-pill'
import { applyBundleSelectionToLines } from '@/lib/bundles/expand-line-items'
import {
  addItemToDocumentBundle,
  removeDocumentLineItem,
} from '@/lib/bundles/document-line-item-actions'
import {
  DocumentLineItemsColumnHeader,
  DOCUMENT_LINE_WIDTH_DEFAULTS,
} from '@/components/documents/document-line-items-column-header'
import { CustomerEstimatePanel } from '@/components/estimates/customer-estimate-panel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type CustomerLine,
  buildCustomerLinesFromGroups,
  collectGroupsFromEditorLines,
  flatLineItemsToCompanyLines,
  mergeCustomerIntoGroups,
  syncCustomerLines,
} from '@/lib/estimates/company-customer-sync'

interface Job {
  id: string
  jobNumber: string
  title: string
}

interface LineItem {
  id?: string
  description: string
  quantity: string
  unitPrice: string
  unitCost?: string
  notes?: string
  vendorId?: string
  vendorName?: string
  taxable: boolean
  taxRate?: string
  isVisibleToClient?: boolean
  // Per-field visibility
  showDescriptionToCustomer: boolean
  showCostToCustomer: boolean
  showPriceToCustomer: boolean
  showTaxToCustomer: boolean
  showNotesToCustomer: boolean
  // Bundle support
  groupId?: string
  groupName?: string
  isGroupHeader?: boolean
  sourceItemId?: string
  sourceBundleId?: string
  isSubtotal?: boolean
}

function createManualGroupId() {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createBlankGroupedLineItem(groupId: string, groupName: string): LineItem {
  return {
    description: '',
    quantity: '1',
    unitPrice: '0',
    taxable: true,
    isVisibleToClient: true,
    showDescriptionToCustomer: false,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: true,
    groupId,
    groupName,
  }
}

function createManualLineBundle(lineNumber: number): LineItem[] {
  const groupId = createManualGroupId()
  const groupName = ''
  const header: LineItem = {
    description: '',
    quantity: '1',
    unitPrice: '0',
    taxable: true,
    isVisibleToClient: true,
    showDescriptionToCustomer: true,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: false,
    groupId,
    groupName,
    isGroupHeader: true,
  }
  void lineNumber
  return [header, createBlankGroupedLineItem(groupId, groupName)]
}

export default function EditInvoicePage() {
  const router = useRouter()
  const params = useParams()
  const invoiceId = params.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [bulkModeActive, setBulkModeActive] = useState(false)
  const [selectedItemIndices, setSelectedItemIndices] = useState<Set<number>>(new Set())
  const [clients, setClients] = useState<PickerClient[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [pickerItems, setPickerItems] = useState<FastPickerItem[]>([])
  const [pickerBundles, setPickerBundles] = useState<FastPickerItem[]>([])
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [optionalItems, setOptionalItems] = useState<LineItem[]>([])
  const [customerLines, setCustomerLines] = useState<CustomerLine[]>([])
  const [invoiceLineView, setInvoiceLineView] = useState<'company' | 'customer'>('company')
  const [lineColWidths, setLineColWidths] = useState<Record<string, number>>(DOCUMENT_LINE_WIDTH_DEFAULTS)
  const [isNotesVisibleToClient, setIsNotesVisibleToClient] = useState(true)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  
  const [formData, setFormData] = useState({
    clientId: '',
    jobId: '',
    title: '',
    taxRate: '0',
    discount: '0',
    invoiceDate: '',
    dueDate: '',
    notes: '',
    terms: '',
    memo: '',
    status: 'DRAFT',
  })

  const lineItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const pickerInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const optionalItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const optionalPickerInputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    fetchClients()
    fetchPickerData()
    fetchInvoice()
  }, [invoiceId])

  // Keep customer bundles in sync with company groups (manually-edited lines stay sticky for good).
  useEffect(() => {
    const companyLines = flatLineItemsToCompanyLines(lineItems)
    setCustomerLines((prev) => syncCustomerLines(companyLines, prev))
  }, [lineItems])

  const fetchClients = async () => {
    try {
      setClients(await fetchAllPickerClients())
    } catch (error) {
      console.error('Error fetching clients:', error)
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

  const fetchInvoice = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        alert('Failed to load invoice')
        router.push('/dashboard/invoices')
        return
      }

      const data = await response.json()
      const inv = data.invoice

      if (!inv) {
        alert('Invoice not found')
        router.push('/dashboard/invoices')
        return
      }

      setInvoiceNumber(inv.invoiceNumber)
      setIsNotesVisibleToClient(inv.isNotesVisibleToClient !== false)

      const taxRatePercent = inv.taxRate ? (parseFloat(inv.taxRate) * 100).toString() : '0'

      setFormData({
        clientId: inv.client?.id || '',
        jobId: inv.job?.id || '',
        title: inv.title || '',
        taxRate: taxRatePercent,
        discount: inv.discount || '0',
        invoiceDate: inv.invoiceDate ? new Date(inv.invoiceDate).toISOString().split('T')[0] : '',
        dueDate: inv.dueDate ? new Date(inv.dueDate).toISOString().split('T')[0] : '',
        notes: inv.notes || '',
        terms: inv.terms || '',
        memo: inv.memo || '',
        status: inv.status || 'DRAFT',
      })

      if (formData.clientId) {
        fetchJobs()
      }

      // Map line items, handling groups
      const groupsMap = new Map<string, { name: string; sourceBundleId?: string }>()
      const mappedItems: LineItem[] = []
      
      inv.lineItems?.forEach((li: any) => {
        if (li.group && !groupsMap.has(li.group.id)) {
          groupsMap.set(li.group.id, {
            name: li.group.name,
            sourceBundleId: li.group.sourceBundleId || undefined,
          })
        }
      })

      const processedGroups = new Set<string>()
      inv.lineItems?.forEach((li: any) => {
        const group = li.group
        if (group && !processedGroups.has(group.id)) {
          mappedItems.push({
            id: `header-${group.id}`,
            description: group.name,
            quantity: '1',
            unitPrice: '0',
            taxable: true,
            showDescriptionToCustomer: true,
            showCostToCustomer: false,
            showPriceToCustomer: true,
            showTaxToCustomer: true,
            showNotesToCustomer: false,
            groupId: group.id,
            groupName: group.name,
            isGroupHeader: true,
            sourceBundleId: group.sourceBundleId || undefined,
          })
          processedGroups.add(group.id)
        }

        const isSubtotalRow = Boolean((li as any).isSubtotal)
        mappedItems.push({
          id: li.id,
          description: li.description,
          quantity: li.quantity.toString(),
          unitPrice: li.unitPrice.toString(),
          unitCost: li.unitCost ? li.unitCost.toString() : undefined,
          notes: li.notes || undefined,
          vendorId: li.vendorId || undefined,
          vendorName: li.vendorName || undefined,
          taxable: li.taxable ?? true,
          taxRate: li.taxRate ? (parseFloat(li.taxRate) * 100).toString() : undefined,
          showDescriptionToCustomer: isSubtotalRow
            ? (li.showDescriptionToCustomer ?? true)
            : (li.showDescriptionToCustomer ?? false),
          showCostToCustomer: li.showCostToCustomer ?? false,
          showPriceToCustomer: li.showPriceToCustomer ?? true,
          showTaxToCustomer: li.showTaxToCustomer ?? true,
          showNotesToCustomer: isSubtotalRow
            ? (li.showNotesToCustomer ?? false)
            : (li.showNotesToCustomer ?? true),
          groupId: li.groupId || undefined,
          sourceItemId: li.sourceItemId || undefined,
          sourceBundleId: li.sourceBundleId || undefined,
          isVisibleToClient: li.isVisibleToClient !== false,
          isSubtotal: isSubtotalRow,
        })
      })

      if (mappedItems.length === 0) {
        mappedItems.push({
          description: '',
          quantity: '1',
          unitPrice: '0',
          taxable: true,
          isVisibleToClient: true,
          showDescriptionToCustomer: false,
          showCostToCustomer: false,
          showPriceToCustomer: true,
          showTaxToCustomer: true,
          showNotesToCustomer: true,
        })
      }

      const groupMeta: Record<
        string,
        { customerDescription?: string | null; customerTotal?: string | null; customerEdited?: boolean | null }
      > = {}
      inv.lineItems?.forEach((li: any) => {
        if (li.group?.id && !groupMeta[li.group.id]) {
          groupMeta[li.group.id] = {
            customerDescription: li.group.customerDescription,
            customerTotal: li.group.customerTotal,
            customerEdited: li.group.customerEdited,
          }
        }
      })
      const companyLines = flatLineItemsToCompanyLines(mappedItems)
      setCustomerLines(buildCustomerLinesFromGroups(companyLines, groupMeta))
      setLineItems(mappedItems)

      // Optional items (can be empty)
      const mappedOptional: LineItem[] =
        inv.optionalItems?.map((li: any) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity?.toString?.() || '1',
          unitPrice: li.unitPrice?.toString?.() || '0',
          unitCost: li.unitCost ? li.unitCost.toString() : undefined,
          notes: li.notes || undefined,
          vendorId: li.vendorId || undefined,
          vendorName: li.vendorName || undefined,
          taxable: li.taxable ?? true,
          taxRate: li.taxRate ? (parseFloat(li.taxRate) * 100).toString() : undefined,
          showDescriptionToCustomer: li.showDescriptionToCustomer ?? false,
          showCostToCustomer: li.showCostToCustomer ?? false,
          showPriceToCustomer: li.showPriceToCustomer ?? true,
          showTaxToCustomer: li.showTaxToCustomer ?? true,
          showNotesToCustomer: li.showNotesToCustomer ?? true,
          groupId: li.groupId || undefined,
          sourceItemId: li.sourceItemId || undefined,
          sourceBundleId: li.sourceBundleId || undefined,
          isVisibleToClient: li.isVisibleToClient !== false,
        })) || []
      setOptionalItems(mappedOptional)
    } catch (error) {
      console.error('Error fetching invoice:', error)
      alert('Failed to load invoice')
    } finally {
      setLoading(false)
    }
  }

  const fetchJobs = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/jobs?clientId=${formData.clientId}&limit=1000`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setJobs(data.jobs || [])
      }
    } catch (error) {
      console.error('Error fetching jobs:', error)
    }
  }

  const addLineItem = () => {
    setLineItems((prev) => {
      const lastHeader = [...prev].reverse().find((item) => item.isGroupHeader && item.groupId)
      if (lastHeader?.groupId) {
        const result = addItemToDocumentBundle(prev, lastHeader.groupId, () =>
          createBlankGroupedLineItem(lastHeader.groupId!, lastHeader.groupName || '')
        )
        focusLinePickerAt(result.focusIndex)
        return result.items
      }
      const bundle = createManualLineBundle(1)
      focusLinePickerAt(prev.length + 1)
      return [...prev, ...bundle]
    })
  }

  const addLineBundle = () => {
    setLineItems((prev) => {
      const nextNumber = prev.filter((item) => item.isGroupHeader).length + 1
      const bundle = createManualLineBundle(nextNumber)
      const focusIndex = prev.length + 1
      focusLinePickerAt(focusIndex)
      return [...prev, ...bundle]
    })
  }

  const addOptionalItem = () => {
    setOptionalItems((prev) => [
      ...prev,
      {
        description: '',
        quantity: '1',
        unitPrice: '0',
        taxable: true,
        isVisibleToClient: true,
        showDescriptionToCustomer: false,
        showCostToCustomer: false,
        showPriceToCustomer: true,
        showTaxToCustomer: true,
        showNotesToCustomer: true,
      },
    ])
  }

  const createBlankLineItem = (): LineItem => ({
    description: '',
    quantity: '1',
    unitPrice: '0',
    taxable: true,
    isVisibleToClient: true,
    showDescriptionToCustomer: false,
    showCostToCustomer: false,
    showPriceToCustomer: true,
    showTaxToCustomer: true,
    showNotesToCustomer: true,
  })

  const focusLinePickerAt = (index: number, optional = false) => {
    setTimeout(() => {
      const refs = optional ? optionalPickerInputRefs : pickerInputRefs
      const containerRefs = optional ? optionalItemRefs : lineItemRefs
      const nextInput = refs.current[index]
      if (nextInput) {
        nextInput.focus()
        nextInput.dispatchEvent(new Event('focus', { bubbles: true }))
      } else {
        const nextContainer = containerRefs.current[index]
        const fallbackInput = nextContainer?.querySelector<HTMLInputElement>('[data-picker-input="true"]')
        if (fallbackInput) {
          fallbackInput.focus()
          fallbackInput.dispatchEvent(new Event('focus', { bubbles: true }))
        }
      }
    }, 100)
  }

  const removeLineItem = (index: number) => {
    setLineItems((prev) => removeDocumentLineItem(prev, index))
  }

  const addItemToBundle = (groupId: string) => {
    setLineItems((prev) => {
      const header = prev.find((item) => item.isGroupHeader && item.groupId === groupId)
      const result = addItemToDocumentBundle(prev, groupId, () =>
        createBlankGroupedLineItem(groupId, header?.groupName || '')
      )
      focusLinePickerAt(result.focusIndex)
      return result.items
    })
  }

  const addOptionalItemToBundle = (groupId: string) => {
    setOptionalItems((prev) => {
      const result = addItemToDocumentBundle(prev, groupId, createBlankLineItem)
      focusLinePickerAt(result.focusIndex, true)
      return result.items
    })
  }

  const insertSubtotalAfter = (index: number) => {
    setLineItems((prev) => {
      const next = [...prev]
      next.splice(index + 1, 0, {
        description: 'Subtotal',
        quantity: '0',
        unitPrice: '0',
        taxable: false,
        isVisibleToClient: true,
        showDescriptionToCustomer: true,
        showCostToCustomer: false,
        showPriceToCustomer: true,
        showTaxToCustomer: false,
        showNotesToCustomer: false,
        isSubtotal: true,
      })
      return next
    })
  }

  const insertLineItemAfter = (index: number) => {
    setLineItems((prev) => {
      const row = prev[index]
      const next = [...prev]
      const blank: LineItem = {
        description: '',
        quantity: '1',
        unitPrice: '0',
        taxable: true,
        isVisibleToClient: true,
        showDescriptionToCustomer: false,
        showCostToCustomer: false,
        showPriceToCustomer: true,
        showTaxToCustomer: true,
        showNotesToCustomer: true,
      }
      if (!row.isSubtotal && row.groupId) {
        blank.groupId = row.groupId
        blank.groupName = row.groupName
      }
      next.splice(index + 1, 0, blank)
      return next
    })
    const newIndex = index + 1
    setTimeout(() => {
      const nextInput = pickerInputRefs.current[newIndex]
      if (nextInput) {
        nextInput.focus()
        nextInput.dispatchEvent(new Event('focus', { bubbles: true }))
      } else {
        const nextContainer = lineItemRefs.current[newIndex]
        const fallbackInput = nextContainer?.querySelector<HTMLInputElement>('[data-picker-input="true"]')
        if (fallbackInput) {
          fallbackInput.focus()
          fallbackInput.dispatchEvent(new Event('focus', { bubbles: true }))
        }
      }
    }, 100)
  }

  const insertOptionalLineItemAfter = (index: number) => {
    setOptionalItems((prev) => {
      const row = prev[index]
      const next = [...prev]
      const blank: LineItem = {
        description: '',
        quantity: '1',
        unitPrice: '0',
        taxable: true,
        isVisibleToClient: true,
        showDescriptionToCustomer: false,
        showCostToCustomer: false,
        showPriceToCustomer: true,
        showTaxToCustomer: true,
        showNotesToCustomer: true,
      }
      if (row.groupId) {
        blank.groupId = row.groupId
        blank.groupName = row.groupName
      }
      next.splice(index + 1, 0, blank)
      return next
    })
    const newIndex = index + 1
    setTimeout(() => {
      const nextInput = optionalPickerInputRefs.current[newIndex]
      if (nextInput) {
        nextInput.focus()
        nextInput.dispatchEvent(new Event('focus', { bubbles: true }))
      } else {
        const nextContainer = optionalItemRefs.current[newIndex]
        const fallbackInput = nextContainer?.querySelector<HTMLInputElement>('[data-picker-input="true"]')
        if (fallbackInput) {
          fallbackInput.focus()
          fallbackInput.dispatchEvent(new Event('focus', { bubbles: true }))
        }
      }
    }, 100)
  }

  const updateLineItem = (index: number, field: keyof LineItem, value: any) => {
    setLineItems((prev) => {
      const updated = [...prev]
      const current = updated[index]
      if (!current) return prev

      // Renaming a Line # / bundle header keeps groupName in sync on all rows in that group.
      if (current.isGroupHeader && current.groupId && (field === 'description' || field === 'groupName')) {
        const nextName = String(value || '')
        return updated.map((item) => {
          if (item.groupId !== current.groupId) return item
          if (item.isGroupHeader) {
            return { ...item, description: nextName, groupName: nextName }
          }
          return { ...item, groupName: nextName }
        })
      }

      updated[index] = { ...current, [field]: value }
      return updated
    })
  }

  const removeOptionalItem = (index: number) => {
    setOptionalItems((prev) => removeDocumentLineItem(prev, index))
  }

  const updateOptionalItem = (index: number, field: keyof LineItem, value: any) => {
    setOptionalItems((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
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
          const newLines = await applyBundleSelectionToLines(
            updated,
            lineIndex,
            { name: bundle?.name || item.name, components: bundle?.components || [] },
            bundleDefId,
            token || '',
            {
              headerExtras: {
                taxable: item.taxable,
                taxRate: item.taxRate?.toString() || '',
                showDescriptionToCustomer: true,
                showCostToCustomer: false,
                showPriceToCustomer: true,
                showTaxToCustomer: true,
                showNotesToCustomer: false,
              },
            }
          )
          setLineItems(newLines)
          return new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              setTimeout(() => resolve(), 0)
            })
          })
        } else {
          updated[lineIndex] = {
            ...updated[lineIndex],
            description: item.name,
            quantity: '1',
            unitPrice: item.defaultUnitPrice.toString(),
            unitCost: item.defaultUnitCost?.toString() || '0',
            taxable: item.taxable,
            taxRate: item.taxRate?.toString() || '',
            sourceBundleId: bundleDefId,
            showDescriptionToCustomer: false,
            showNotesToCustomer: true,
          }
        }
      } catch (error) {
        console.error('Error fetching bundle details:', error)
        updated[lineIndex] = {
          ...updated[lineIndex],
          description: item.name,
          quantity: '1',
          unitPrice: item.defaultUnitPrice.toString(),
          unitCost: item.defaultUnitCost?.toString() || '0',
          taxable: item.taxable,
          taxRate: item.taxRate?.toString() || '',
          sourceBundleId: item.bundleId || undefined,
          showDescriptionToCustomer: false,
          showNotesToCustomer: true,
        }
      }
    } else {
      const computedUnitPrice =
        item.pricingMode === 'PERCENT_OF_ABOVE'
          ? computePercentOfAbovePrice(lineItems.slice(0, lineIndex), item.percentOfAboveRate || 0)
          : item.defaultUnitPrice
      updated[lineIndex] = {
        ...updated[lineIndex],
        description: item.name,
        quantity: '1',
        unitPrice: computedUnitPrice.toString(),
        unitCost: item.defaultUnitCost?.toString() || '0',
        notes:
          (item.description && item.description.trim()) ||
          (item.notes && item.notes.trim() && item.notes !== 'Imported from QuickBooks historical import'
            ? item.notes
            : ''),
        vendorId: item.vendorId || null,
        vendorName: item.vendorName || null,
        taxable: item.taxable,
        taxRate: item.taxRate?.toString() || '',
        sourceItemId: item.id,
        showDescriptionToCustomer: false,
        showNotesToCustomer: true,
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

  const handleOptionalItemSelect = async (item: FastPickerItem, lineIndex: number) => {
    const updated = [...optionalItems]

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
          const newLines = await applyBundleSelectionToLines(
            updated,
            lineIndex,
            { name: bundle?.name || item.name, components: bundle?.components || [] },
            bundleDefId,
            token || '',
            {
              groupIdPrefix: 'group-opt-',
              headerExtras: {
                taxable: item.taxable,
                taxRate: item.taxRate?.toString() || '',
                showDescriptionToCustomer: true,
                showCostToCustomer: false,
                showPriceToCustomer: true,
                showTaxToCustomer: true,
                showNotesToCustomer: false,
              },
            }
          )
          setOptionalItems(newLines)
          return
        }
      } catch (error) {
        console.error('Error expanding bundle (optional items):', error)
      }
    }

    // Single item (optional)
    updated[lineIndex] = {
      ...updated[lineIndex],
      description: item.name,
      quantity: '1',
      unitPrice: item.defaultUnitPrice.toString(),
      unitCost: item.defaultUnitCost?.toString() || '0',
      notes:
        (item.description && item.description.trim()) ||
        (item.notes && item.notes.trim() && item.notes !== 'Imported from QuickBooks historical import'
          ? item.notes
          : ''),
      vendorId: item.vendorId || null,
      vendorName: item.vendorName || null,
      taxable: item.taxable,
      taxRate: item.taxRate?.toString() || '',
      sourceItemId: item.id,
      showDescriptionToCustomer: false,
      showNotesToCustomer: true,
    }

    setOptionalItems(updated)
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
          unitPrice: '0',
          taxable: true,
          showDescriptionToCustomer: false,
          showCostToCustomer: false,
          showPriceToCustomer: true,
          showTaxToCustomer: true,
          showNotesToCustomer: true,
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

  const handleNextOptionalLine = (currentIndex: number) => {
    const nextIndex = currentIndex + 1
    setOptionalItems((prev) => {
      if (nextIndex < prev.length) return prev
      return [
        ...prev,
        {
          description: '',
          quantity: '1',
          unitPrice: '0',
          taxable: true,
          showDescriptionToCustomer: false,
          showCostToCustomer: false,
          showPriceToCustomer: true,
          showTaxToCustomer: true,
          showNotesToCustomer: true,
        },
      ]
    })
    setTimeout(() => {
      const nextInput = optionalPickerInputRefs.current[nextIndex]
      if (nextInput) {
        nextInput.focus()
        nextInput.dispatchEvent(new Event('focus', { bubbles: true }))
      } else {
        const nextContainer = optionalItemRefs.current[nextIndex]
        const fallbackInput = nextContainer?.querySelector<HTMLInputElement>('[data-picker-input="true"]')
        if (fallbackInput) {
          fallbackInput.focus()
          fallbackInput.dispatchEvent(new Event('focus', { bubbles: true }))
        }
      }
    }, 100)
  }

  const toggleVisibility = (index: number, field: 'description' | 'cost' | 'price' | 'tax' | 'notes') => {
    const updated = [...lineItems]
    const fieldMap = {
      description: 'showDescriptionToCustomer',
      cost: 'showCostToCustomer',
      price: 'showPriceToCustomer',
      tax: 'showTaxToCustomer',
      notes: 'showNotesToCustomer',
    } as const
    
    updated[index] = {
      ...updated[index],
      [fieldMap[field]]: !updated[index][fieldMap[field]],
    }
    setLineItems(updated)
  }

  const toggleOptionalVisibility = (index: number, field: 'description' | 'cost' | 'price' | 'tax' | 'notes') => {
    const updated = [...optionalItems]
    const fieldMap = {
      description: 'showDescriptionToCustomer',
      cost: 'showCostToCustomer',
      price: 'showPriceToCustomer',
      tax: 'showTaxToCustomer',
      notes: 'showNotesToCustomer',
    } as const

    updated[index] = {
      ...updated[index],
      [fieldMap[field]]: !updated[index][fieldMap[field]],
    }
    setOptionalItems(updated)
  }

  const toggleLineRowVisibility = (index: number) => {
    setLineItems((prev) => {
      const copy = [...prev]
      copy[index] = { ...copy[index], isVisibleToClient: !(copy[index].isVisibleToClient ?? true) }
      return copy
    })
  }

  const setGroupLineItemsVisibility = (groupId: string, isVisibleToClient: boolean) => {
    setLineItems((prev) => prev.map((item) =>
      item.groupId === groupId && !item.isGroupHeader ? { ...item, isVisibleToClient } : item
    ))
  }

  type VisibilityField = 'showDescriptionToCustomer' | 'showNotesToCustomer' | 'showPriceToCustomer' | 'showCostToCustomer' | 'showTaxToCustomer'
  const setBulkFieldVisibility = (field: VisibilityField, value: boolean) => {
    setLineItems((prev) => prev.map((item, idx) => {
      if (item.isGroupHeader) return item
      if (bulkModeActive && selectedItemIndices.size > 0 && !selectedItemIndices.has(idx)) return item
      return { ...item, [field]: value }
    }))
    if (!bulkModeActive || selectedItemIndices.size === 0) {
      setOptionalItems((prev) => prev.map((item) => item.isGroupHeader ? item : { ...item, [field]: value }))
    }
  }

  const toggleSelectedItem = (index: number) => {
    setSelectedItemIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const selectAllLineItems = () => {
    setSelectedItemIndices(new Set(lineItems.map((_, i) => i).filter((i) => !lineItems[i].isGroupHeader && !lineItems[i].isSubtotal)))
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

  const toggleOptionalRowVisibility = (index: number) => {
    setOptionalItems((prev) => {
      const copy = [...prev]
      copy[index] = { ...copy[index], isVisibleToClient: !(copy[index].isVisibleToClient ?? true) }
      return copy
    })
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

  const reorderOptionalItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    setOptionalItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.title.trim()) {
      alert('Please enter a title')
      return
    }

    setSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      
      const subtotal = lineItems.reduce((sum, item) => {
        if (item.isGroupHeader || item.isSubtotal) return sum
        return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')
      }, 0)

      const discount = parseFloat(formData.discount || '0')
      const subtotalAfterDiscount = subtotal - discount
      const taxRate = parseFloat(formData.taxRate || '0') / 100
      const tax = subtotalAfterDiscount * taxRate
      const total = subtotalAfterDiscount + tax

      const apiLineItems = lineItems
        .filter(item => !item.isGroupHeader)
        .map((item, index) => ({
          id: item.id,
          description: item.isSubtotal ? 'Subtotal' : item.description,
          quantity: item.isSubtotal ? 0 : parseFloat(item.quantity || '1'),
          unitPrice: item.isSubtotal ? 0 : parseFloat(item.unitPrice || '0'),
          unitCost: item.isSubtotal ? null : (item.unitCost ? parseFloat(item.unitCost) : null),
          total: item.isSubtotal ? 0 : (parseFloat(item.quantity || '1') * parseFloat(item.unitPrice || '0')),
          sortOrder: index,
          isSubtotal: item.isSubtotal || false,
          isVisibleToClient: item.isVisibleToClient !== false,
          showDescriptionToCustomer: item.showDescriptionToCustomer,
          showCostToCustomer: item.showCostToCustomer,
          showPriceToCustomer: item.showPriceToCustomer,
          showTaxToCustomer: item.showTaxToCustomer,
          showNotesToCustomer: item.showNotesToCustomer,
          vendorId: item.isSubtotal ? null : (item.vendorId || null),
          taxable: item.isSubtotal ? false : item.taxable,
          taxRate: item.isSubtotal ? null : (item.taxRate ? parseFloat(item.taxRate) / 100 : null),
          notes: item.notes || null,
          groupId: item.groupId || null,
          sourceItemId: item.sourceItemId || null,
          sourceBundleId: item.sourceBundleId || null,
        }))

      const apiOptionalItems = optionalItems
        .filter(item => !item.isGroupHeader)
        .map((item, index) => ({
          id: item.id,
          description: item.description,
          quantity: parseFloat(item.quantity || '1'),
          unitPrice: parseFloat(item.unitPrice || '0'),
          unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
          total: parseFloat(item.quantity || '1') * parseFloat(item.unitPrice || '0'),
          sortOrder: index,
          isVisibleToClient: item.isVisibleToClient !== false,
          showDescriptionToCustomer: item.showDescriptionToCustomer,
          showCostToCustomer: item.showCostToCustomer,
          showPriceToCustomer: item.showPriceToCustomer,
          showTaxToCustomer: item.showTaxToCustomer,
          showNotesToCustomer: item.showNotesToCustomer,
          vendorId: item.vendorId || null,
          taxable: item.taxable,
          taxRate: item.taxRate ? parseFloat(item.taxRate) / 100 : null,
          notes: item.notes || null,
          groupId: item.groupId || null,
          sourceItemId: item.sourceItemId || null,
          sourceBundleId: item.sourceBundleId || null,
        }))

      const groupsPayload = mergeCustomerIntoGroups(
        collectGroupsFromEditorLines(lineItems, optionalItems),
        customerLines
      )

      const response = await fetch(`/api/invoices/${invoiceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientId: formData.clientId || null,
          jobId: formData.jobId || null,
          invoiceNumber,
          title: formData.title,
          taxRate: taxRate,
          discount,
          status: formData.status,
          invoiceDate: formData.invoiceDate || new Date().toISOString().split('T')[0],
          dueDate: formData.dueDate || null,
          notes: formData.notes || null,
          isNotesVisibleToClient,
          terms: formData.terms || null,
          memo: formData.memo || null,
          lineItems: apiLineItems,
          optionalItems: apiOptionalItems,
          groups: groupsPayload,
        }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to update invoice' }))
        alert(errorData.error || 'Failed to update invoice')
        return
      }

      router.replace(`/dashboard/invoices/${invoiceId}`)
    } catch (error) {
      console.error('Error updating invoice:', error)
      alert('Failed to update invoice. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleDuplicate = async () => {
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/invoices/${invoiceId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate invoice')
        return
      }
      if (data?.id) {
        router.push(`/dashboard/invoices/${data.id}/edit`)
      } else {
        router.push('/dashboard/invoices')
      }
    } catch (error) {
      console.error('Duplicate invoice error:', error)
      alert('Failed to duplicate invoice')
    } finally {
      setDuplicating(false)
    }
  }

  const subtotal = lineItems.reduce((sum, item) => {
    if (item.isGroupHeader || item.isSubtotal) return sum
    return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')
  }, 0)
  
  const discount = parseFloat(formData.discount || '0')
  const subtotalAfterDiscount = subtotal - discount
  const taxRate = parseFloat(formData.taxRate || '0') / 100
  const tax = subtotalAfterDiscount * taxRate
  const total = subtotalAfterDiscount + tax

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading invoice...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref={`/dashboard/invoices/${invoiceId}`} parentHref={`/dashboard/invoices/${invoiceId}`} mode="parent" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Edit Invoice</h1>
          <p className="mt-2 text-gray-600">Invoice #{invoiceNumber}</p>
        </div>
        <Button type="button" variant="outline" onClick={handleDuplicate} disabled={duplicating}>
          <Copy className="mr-2 h-4 w-4" />
          {duplicating ? 'Duplicating...' : 'Duplicate'}
        </Button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Invoice Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="clientId">Client</Label>
                  <SearchableClientSelect
                    clients={clients}
                    value={formData.clientId}
                    onSelect={(value) => {
                      setFormData({ ...formData, clientId: value, jobId: '' })
                      if (value) fetchJobs()
                    }}
                    placeholder="Select a client..."
                  />
                </div>
                <div>
                  <Label htmlFor="invoiceNumber">Invoice #</Label>
                  <Input
                    id="invoiceNumber"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="ex: INV-000123"
                  />
                </div>
                <div>
                  <Label htmlFor="jobId">Job (Optional)</Label>
                  <Select
                    value={formData.jobId || '__none__'}
                    onValueChange={(value) => setFormData({ ...formData, jobId: value === '__none__' ? '' : value })}
                    disabled={!formData.clientId}
                  >
                    <SelectTrigger id="jobId">
                      <SelectValue placeholder="No job" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No job</SelectItem>
                      {jobs.map((job) => (
                        <SelectItem key={job.id} value={job.id}>
                          {job.jobNumber} - {job.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    required
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="e.g., Kitchen Remodel Invoice"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="invoiceDate">Invoice Date *</Label>
                    <Input
                      id="invoiceDate"
                      type="date"
                      required
                      value={formData.invoiceDate}
                      onChange={(e) => setFormData({ ...formData, invoiceDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="dueDate">Due Date</Label>
                    <Input
                      id="dueDate"
                      type="date"
                      value={formData.dueDate}
                      onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                    <SelectTrigger id="status">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="SENT">Sent</SelectItem>
                      <SelectItem value="VIEWED">Viewed</SelectItem>
                      <SelectItem value="PARTIAL">Partially Paid</SelectItem>
                      <SelectItem value="PAID">Paid</SelectItem>
                      <SelectItem value="OVERDUE">Overdue</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle>Line Items</CardTitle>
                      <CardDescription>
                        Switch between company (detailed / QB) and customer (bundled) invoices
                      </CardDescription>
                    </div>
                    <Tabs
                      value={invoiceLineView}
                      onValueChange={(v) => setInvoiceLineView(v as 'company' | 'customer')}
                    >
                      <TabsList>
                        <TabsTrigger value="company" className="gap-1.5">
                          <Building2 className="h-4 w-4" />
                          Company
                        </TabsTrigger>
                        <TabsTrigger value="customer" className="gap-1.5">
                          <User className="h-4 w-4" />
                          Customer
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  {invoiceLineView === 'company' && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-gray-500 font-medium self-center">Show to customer:</span>
                    {(['showDescriptionToCustomer', 'showNotesToCustomer', 'showPriceToCustomer', 'showCostToCustomer', 'showTaxToCustomer'] as VisibilityField[]).map((field) => {
                      const labels: Record<VisibilityField, string> = { showDescriptionToCustomer: 'Name', showNotesToCustomer: 'Description', showPriceToCustomer: 'Price', showCostToCustomer: 'Cost', showTaxToCustomer: 'Tax' }
                      const targetItems = (bulkModeActive && selectedItemIndices.size > 0)
                        ? lineItems.filter((_, i) => selectedItemIndices.has(i))
                        : lineItems
                      const anyVisible = targetItems.some((li) => !li.isGroupHeader && li[field] !== false)
                      return (
                        <button key={field} type="button"
                          onClick={() => setBulkFieldVisibility(field, !anyVisible)}
                          title={`${anyVisible ? 'Hide' : 'Show'} ${labels[field]} for ${bulkModeActive && selectedItemIndices.size > 0 ? 'selected' : 'all'} items`}
                          className={cnCustomerVisibilityBulkPill(anyVisible)}
                        >
                          {anyVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          {labels[field]}
                        </button>
                      )
                    })}
                    <span className="text-gray-300 self-center">|</span>
                    <button type="button"
                      onClick={() => { setBulkModeActive(!bulkModeActive); setSelectedItemIndices(new Set()) }}
                      className={`px-2 py-1 rounded border font-medium ${bulkModeActive ? 'bg-violet-50 border-violet-300 text-violet-700' : 'bg-gray-50 border-gray-300 text-gray-600'}`}
                    >{bulkModeActive ? `Bulk (${selectedItemIndices.size} sel.)` : 'Bulk Select'}</button>
                    {bulkModeActive && (
                      <>
                        <button type="button" onClick={selectAllLineItems}
                          className="px-2 py-1 rounded border bg-gray-50 border-gray-300 text-gray-600 font-medium hover:bg-gray-100"
                        >All</button>
                        <button type="button" onClick={() => setSelectedItemIndices(new Set())}
                          className="px-2 py-1 rounded border bg-gray-50 border-gray-300 text-gray-600 font-medium hover:bg-gray-100"
                        >Clear</button>
                      </>
                    )}
                  </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {invoiceLineView === 'customer' ? (
                  <CustomerEstimatePanel
                    customerLines={customerLines}
                    onChange={setCustomerLines}
                    entityLabel="invoice"
                  />
                ) : (
                <>
                <DocumentLineItemsColumnHeader
                  entity="invoice-edit-line-items"
                  onWidthsChange={setLineColWidths}
                />
                <div className="space-y-2">
                  {lineItems.map((item, index) => {
                    const isGroupHeader = item.isGroupHeader
                    const isInGroup = !!item.groupId && !isGroupHeader
                    const isSubtotalRow = Boolean(item.isSubtotal)

                    const prevSubtotalIdx = isSubtotalRow
                      ? (() => {
                          for (let k = index - 1; k >= 0; k--) {
                            if (lineItems[k].isSubtotal) return k
                          }
                          return -1
                        })()
                      : -1
                    const subtotalDisplay = isSubtotalRow
                      ? lineItems.slice(prevSubtotalIdx + 1, index).reduce((sum, li) => {
                          if (li.isGroupHeader || li.isSubtotal) return sum
                          return sum + parseFloat(li.quantity || '0') * parseFloat(li.unitPrice || '0')
                        }, 0)
                      : 0

                    if (isSubtotalRow) {
                      return (
                        <div
                          key={index}
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
                          className="flex items-center gap-2 p-2 rounded border border-slate-300 bg-slate-50"
                        >
                          <LineItemDragHandle transferKey="text/line-index" index={index} />
                          <span className="text-sm font-semibold text-slate-700 flex-1">Subtotal</span>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-800">${subtotalDisplay.toFixed(2)}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Insert line below"
                              onClick={() => insertLineItemAfter(index)}
                              className="text-green-600 hover:text-green-800 p-1 h-auto"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeLineItem(index)}
                              className="text-red-400 hover:text-red-600 p-1 h-auto"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )
                    }

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
                        className={`flex gap-2 ${isGroupHeader ? 'items-center' : 'items-start'} p-2 rounded border ${
                          isGroupHeader
                            ? 'bg-purple-50 border-purple-200'
                            : isInGroup
                            ? 'bg-purple-25 border-purple-100 ml-4'
                            : item.isVisibleToClient === false
                              ? 'border-gray-300 opacity-80'
                              : 'border-gray-300'
                        }`}
                      >
                        {!isGroupHeader && bulkModeActive && !isSubtotalRow && (
                          <div className="flex items-center pt-2">
                            <Checkbox
                              checked={selectedItemIndices.has(index)}
                              onCheckedChange={() => toggleSelectedItem(index)}
                            />
                          </div>
                        )}

                        {isGroupHeader ? (
                          <div className="flex flex-col gap-1 items-center shrink-0 self-center">
                            <LineItemDragHandle transferKey="text/line-index" index={index} />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Insert line below"
                              onClick={() => insertLineItemAfter(index)}
                              className="p-1 h-7 text-green-600 hover:text-green-800"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1 items-center shrink-0">
                            <LineItemDragHandle transferKey="text/line-index" index={index} />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleLineRowVisibility(index)}
                              title={
                                item.isVisibleToClient !== false
                                  ? 'Hide entire line from customer (PDF & portal)'
                                  : 'Show line to customer'
                              }
                              className="p-1 h-6"
                            >
                              {item.isVisibleToClient !== false ? (
                                <Eye className="h-3 w-3 text-gray-600" />
                              ) : (
                                <EyeOff className="h-3 w-3 text-gray-400" />
                              )}
                            </Button>
                          </div>
                        )}

                        <div className="line-item-field-wide flex-1 space-y-1" style={{ minWidth: lineColWidths.name || 200 }}>
                          {isGroupHeader ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-purple-700 px-2 py-0.5 text-xs font-semibold text-white shrink-0">
                                Line #
                                {lineItems
                                  .slice(0, index + 1)
                                  .filter((li) => li.isGroupHeader).length}
                              </span>
                              <Input
                                value={item.description}
                                onChange={(e) => updateLineItem(index, 'description', e.target.value)}
                                placeholder="Name this bundle / Line #"
                                className="flex-1 min-w-[180px] font-semibold"
                              />
                              <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded">
                                Bundle
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                title="Add item to this bundle"
                                onClick={() => item.groupId && addItemToBundle(item.groupId)}
                                className="h-8 text-xs shrink-0"
                              >
                                <Plus className="h-3 w-3 mr-1" />
                                Add item
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setGroupLineItemsVisibility(
                                    item.groupId || '',
                                    lineItems.some((li) => li.groupId === item.groupId && !li.isGroupHeader && li.isVisibleToClient === false)
                                  )
                                }
                                title="Show or hide this whole section for the customer"
                                className="p-1 h-7"
                              >
                                {lineItems.some((li) => li.groupId === item.groupId && !li.isGroupHeader && li.isVisibleToClient === false) ? (
                                  <EyeOff className="h-4 w-4 text-gray-400" />
                                ) : (
                                  <Eye className="h-4 w-4 text-gray-600" />
                                )}
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-1">
                                <Label className="text-xs text-gray-500">Name</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'description')}
                                  title={item.showDescriptionToCustomer ? 'Hide item name from customer' : 'Show item name to customer'}
                                  className="visibility-toggle-btn"
                                >
                                  {item.showDescriptionToCustomer ? (
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
                                inputRef={(el) => {
                                  pickerInputRefs.current[index] = el
                                }}
                              />
                              <div className="flex items-center gap-1">
                                <Label className="text-xs text-gray-500">Description</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  tabIndex={-1}
                                  onClick={() => toggleVisibility(index, 'notes')}
                                  title={item.showNotesToCustomer ? 'Hide description from customer' : 'Show description to customer'}
                                  className="visibility-toggle-btn"
                                >
                                  {item.showNotesToCustomer ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <textarea
                                value={item.notes || ''}
                                onChange={(e) => updateLineItem(index, 'notes', e.target.value)}
                                placeholder="Description (optional)"
                                rows={2}
                                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y whitespace-pre-wrap"
                                data-col="notes"
                              />
                            </>
                          )}
                        </div>

                        {!isGroupHeader && (
                          <>
                            <div style={{ width: lineColWidths.qty || 80 }} className="shrink-0">
                              <Input
                                type="number"
                                calculator
                                step="0.01"
                                placeholder="Qty"
                                value={item.quantity}
                                onChange={(e) => updateLineItem(index, 'quantity', e.target.value)}
                                required
                                data-col="quantity"
                              />
                            </div>

                            <div className="line-item-field-numeric relative shrink-0" style={{ width: lineColWidths.price || 112 }}>
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Price</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleVisibility(index, 'price')}
                                  title={item.showPriceToCustomer ? 'Hide price from customer' : 'Show price to customer'}
                                  className="visibility-toggle-btn"
                                >
                                  {item.showPriceToCustomer ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <Input
                                type="number"
                                calculator
                                step="0.01"
                                placeholder="0.00"
                                value={item.unitPrice}
                                onChange={(e) => updateLineItem(index, 'unitPrice', e.target.value)}
                                required
                                data-col="unitPrice"
                              />
                            </div>

                            <div className="line-item-field-numeric relative shrink-0" style={{ width: lineColWidths.cost || 112 }}>
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Cost</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleVisibility(index, 'cost')}
                                  title={item.showCostToCustomer ? 'Hide cost from customer' : 'Show cost to customer'}
                                  className="visibility-toggle-btn"
                                >
                                  {item.showCostToCustomer ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <Input
                                type="number"
                                calculator
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                value={item.unitCost || ''}
                                onChange={(e) => updateLineItem(index, 'unitCost', e.target.value)}
                                className="bg-gray-50"
                                data-col="unitCost"
                              />
                            </div>

                            <div className="line-item-field-numeric relative">
                              <div className="flex items-center gap-1 mb-1">
                                <Label className="text-xs text-gray-500">Tax</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleVisibility(index, 'tax')}
                                  title={item.showTaxToCustomer ? 'Hide tax from customer' : 'Show tax to customer'}
                                  className="visibility-toggle-btn"
                                >
                                  {item.showTaxToCustomer ? (
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  ) : (
                                    <EyeOff className="h-3 w-3 text-gray-400" />
                                  )}
                                </Button>
                              </div>
                              <div className="flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={item.taxable}
                                  onChange={(e) => updateLineItem(index, 'taxable', e.target.checked)}
                                  className="h-4 w-4"
                                  title="Taxable"
                                />
                                <Input
                                  type="number"
                                calculator
                                  step="0.01"
                                  min="0"
                                  max="100"
                                  placeholder="%"
                                  value={item.taxRate || ''}
                                  onChange={(e) => updateLineItem(index, 'taxRate', e.target.value)}
                                  className="text-xs w-16"
                                />
                              </div>
                            </div>

                            {/* Total (Quantity × Unit Price) */}
                            <div className="line-item-field-numeric">
                              <Label className="text-xs text-gray-500 mb-1 block">Total</Label>
                              <div className="px-3 py-2 bg-gray-50 rounded border text-right font-medium">
                                ${(parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')).toFixed(2)}
                              </div>
                            </div>
                          </>
                        )}

                        {!isGroupHeader && !isSubtotalRow && (
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Insert line below"
                              onClick={() => insertLineItemAfter(index)}
                              className="text-green-600 hover:text-green-800 px-1.5"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Insert subtotal after this item"
                              onClick={() => insertSubtotalAfter(index)}
                              className="text-blue-500 hover:text-blue-700 px-1.5"
                            >
                              Σ
                            </Button>
                          </div>
                        )}
                        {lineItems.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title={isGroupHeader ? 'Remove entire bundle' : 'Remove line'}
                            onClick={() => removeLineItem(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button type="button" variant="outline" onClick={addLineItem}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Line Item
                  </Button>
                  <Button type="button" variant="outline" onClick={addLineBundle}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Line #
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-dashed"
                    onClick={() => {
                      setLineItems(prev => [
                        ...prev,
                        {
                          description: 'Subtotal',
                          quantity: '0',
                          unitPrice: '0',
                          taxable: false,
                          isVisibleToClient: true,
                          showDescriptionToCustomer: true,
                          showCostToCustomer: false,
                          showPriceToCustomer: true,
                          showTaxToCustomer: false,
                          showNotesToCustomer: false,
                          isSubtotal: true,
                        },
                      ])
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Subtotal Row
                  </Button>
                </div>
                </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Optional Items</CardTitle>
                <CardDescription>Optional items do not affect the invoice total unless added later.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {optionalItems.length === 0 ? (
                  <p className="text-sm text-gray-500">No optional items yet.</p>
                ) : (
                  <div className="space-y-2">
                    {optionalItems.map((item, index) => {
                      const isGroupHeader = item.isGroupHeader
                      const isInGroup = !!item.groupId && !isGroupHeader
                      const isVisible = item.isVisibleToClient !== false

                      return (
                        <div
                          key={`opt-${index}`}
                          ref={(el) => {
                            optionalItemRefs.current[index] = el
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            maybeAutoScrollDuringDrag(e.clientY)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            const from = parseInt(e.dataTransfer.getData('text/opt-line-index'), 10)
                            if (!Number.isFinite(from)) return
                            reorderOptionalItems(from, index)
                          }}
                          className={`flex gap-2 ${isGroupHeader ? 'items-center' : 'items-start'} p-2 rounded border ${
                            isGroupHeader
                              ? 'bg-purple-50 border-purple-200'
                              : isInGroup
                                ? 'bg-purple-25 border-purple-100 ml-4'
                                : 'border-gray-300'
                          } ${!isGroupHeader && !isVisible ? 'opacity-70' : ''}`}
                        >
                          {isGroupHeader ? (
                            <div className="flex flex-col gap-1 items-center shrink-0 self-center">
                              <LineItemDragHandle transferKey="text/opt-line-index" index={index} />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title="Insert line below"
                                onClick={() => insertOptionalLineItemAfter(index)}
                                className="p-1 h-7 text-green-600 hover:text-green-800"
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1 items-center shrink-0">
                              <LineItemDragHandle transferKey="text/opt-line-index" index={index} />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleOptionalRowVisibility(index)}
                                title={
                                  isVisible ? 'Hide optional item from customer' : 'Show optional item to customer'
                                }
                                className="p-1 h-6"
                              >
                                {isVisible ? (
                                  <Eye className="h-3 w-3 text-gray-600" />
                                ) : (
                                  <EyeOff className="h-3 w-3 text-gray-400" />
                                )}
                              </Button>
                            </div>
                          )}

                          <div className="line-item-field-wide flex-1 space-y-1">
                            {isGroupHeader ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  value={item.description}
                                  onChange={(e) => updateOptionalItem(index, 'description', e.target.value)}
                                  placeholder="Bundle name"
                                  className="flex-1 font-semibold"
                                  readOnly
                                />
                                <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded">Bundle</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  title="Add item to this bundle (this invoice only)"
                                  onClick={() => item.groupId && addOptionalItemToBundle(item.groupId)}
                                  className="h-7 text-xs shrink-0"
                                >
                                  <Plus className="h-3 w-3 mr-1" />
                                  Add item
                                </Button>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center gap-1">
                                  <Label className="text-xs text-gray-500">Name</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    tabIndex={-1}
                                    onClick={() => toggleOptionalVisibility(index, 'description')}
                                    title={item.showDescriptionToCustomer ? 'Hide item name from customer' : 'Show item name to customer'}
                                    className="visibility-toggle-btn"
                                  >
                                    {item.showDescriptionToCustomer ? (
                                      <Eye className="h-3 w-3 text-gray-600" />
                                    ) : (
                                      <EyeOff className="h-3 w-3 text-gray-400" />
                                    )}
                                  </Button>
                                </div>
                                <FastPicker
                                  value={item.description}
                                  onChange={(value) => updateOptionalItem(index, 'description', value)}
                                  onSelect={(selectedItem) => handleOptionalItemSelect(selectedItem, index)}
                                  onNextLine={() => handleNextOptionalLine(index)}
                                  items={pickerItems}
                                  bundles={pickerBundles}
                                  placeholder="Type to search items..."
                                  className="w-full"
                                  inputRef={(el) => {
                                    optionalPickerInputRefs.current[index] = el
                                  }}
                                />
                                <div className="flex items-center gap-1">
                                  <Label className="text-xs text-gray-500">Description</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    tabIndex={-1}
                                    onClick={() => toggleOptionalVisibility(index, 'notes')}
                                    title={item.showNotesToCustomer ? 'Hide description from customer' : 'Show description to customer'}
                                    className="visibility-toggle-btn"
                                  >
                                    {item.showNotesToCustomer ? (
                                      <Eye className="h-3 w-3 text-gray-600" />
                                    ) : (
                                      <EyeOff className="h-3 w-3 text-gray-400" />
                                    )}
                                  </Button>
                                </div>
                                <textarea
                                  value={item.notes || ''}
                                  onChange={(e) => updateOptionalItem(index, 'notes', e.target.value)}
                                  placeholder="Description (optional)"
                                  rows={1}
                                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                                />
                              </>
                            )}
                          </div>

                          {!isGroupHeader && (
                            <>
                              <div className="w-20">
                                <Input
                                  type="number"
                                calculator
                                  step="0.01"
                                  placeholder="Qty"
                                  value={item.quantity}
                                  onChange={(e) => updateOptionalItem(index, 'quantity', e.target.value)}
                                  required
                                />
                              </div>

                              <div className="line-item-field-numeric relative">
                                <div className="flex items-center gap-1 mb-1">
                                  <Label className="text-xs text-gray-500">Price</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleOptionalVisibility(index, 'price')}
                                    title={item.showPriceToCustomer ? 'Hide price from customer' : 'Show price to customer'}
                                    className="visibility-toggle-btn"
                                  >
                                    {item.showPriceToCustomer ? (
                                      <Eye className="h-3 w-3 text-gray-600" />
                                    ) : (
                                      <EyeOff className="h-3 w-3 text-gray-400" />
                                    )}
                                  </Button>
                                </div>
                                <Input
                                  type="number"
                                calculator
                                  step="0.01"
                                  placeholder="0.00"
                                  value={item.unitPrice}
                                  onChange={(e) => updateOptionalItem(index, 'unitPrice', e.target.value)}
                                  required
                                />
                              </div>

                              <div className="line-item-field-numeric relative">
                                <div className="flex items-center gap-1 mb-1">
                                  <Label className="text-xs text-gray-500">Cost</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleOptionalVisibility(index, 'cost')}
                                    title={item.showCostToCustomer ? 'Hide cost from customer' : 'Show cost to customer'}
                                    className="visibility-toggle-btn"
                                  >
                                    {item.showCostToCustomer ? (
                                      <Eye className="h-3 w-3 text-gray-600" />
                                    ) : (
                                      <EyeOff className="h-3 w-3 text-gray-400" />
                                    )}
                                  </Button>
                                </div>
                                <Input
                                  type="number"
                                calculator
                                  step="0.01"
                                  min="0"
                                  placeholder="0.00"
                                  value={item.unitCost || ''}
                                  onChange={(e) => updateOptionalItem(index, 'unitCost', e.target.value)}
                                />
                              </div>

                              <div className="line-item-field-numeric">
                                <div className="flex items-center gap-1 mb-1">
                                  <Label className="text-xs text-gray-500">Tax</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleOptionalVisibility(index, 'tax')}
                                    title={item.showTaxToCustomer ? 'Hide tax from customer' : 'Show tax to customer'}
                                    className="visibility-toggle-btn"
                                  >
                                    {item.showTaxToCustomer ? (
                                      <Eye className="h-3 w-3 text-gray-600" />
                                    ) : (
                                      <EyeOff className="h-3 w-3 text-gray-400" />
                                    )}
                                  </Button>
                                </div>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={item.taxable}
                                    onChange={(e) => updateOptionalItem(index, 'taxable', e.target.checked)}
                                    className="h-4 w-4"
                                    title="Taxable"
                                  />
                                  <Input
                                    type="number"
                                calculator
                                    step="0.01"
                                    min="0"
                                    max="100"
                                    placeholder="%"
                                    value={item.taxRate || ''}
                                    onChange={(e) => updateOptionalItem(index, 'taxRate', e.target.value)}
                                    className="text-xs w-16"
                                  />
                                </div>
                              </div>

                              {/* Total (Quantity × Unit Price) */}
                              <div className="line-item-field-numeric">
                                <Label className="text-xs text-gray-500 mb-1 block">Total</Label>
                                <div className="px-3 py-2 bg-gray-50 rounded border text-right font-medium">
                                  ${(parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')).toFixed(2)}
                                </div>
                              </div>
                            </>
                          )}

                          {!isGroupHeader && (
                            <div className="flex items-center gap-0.5 shrink-0 self-start pt-6">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title="Insert line below"
                                onClick={() => insertOptionalLineItemAfter(index)}
                                className="text-green-600 hover:text-green-800 px-1.5"
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => removeOptionalItem(index)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                <Button type="button" variant="outline" onClick={addOptionalItem}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Optional Item
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Additional Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsNotesVisibleToClient(!isNotesVisibleToClient)}
                      title={isNotesVisibleToClient ? 'Hide from client' : 'Show to client'}
                      className="p-1"
                    >
                      {isNotesVisibleToClient ? (
                        <Eye className="h-4 w-4 text-gray-600" />
                      ) : (
                        <EyeOff className="h-4 w-4 text-gray-400" />
                      )}
                    </Button>
                  </div>
                  <textarea
                    id="notes"
                    rows={4}
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      !isNotesVisibleToClient ? 'bg-gray-50 border-gray-200' : 'border-gray-300'
                    }`}
                  />
                </div>
                <div>
                  <Label htmlFor="terms">Terms & Conditions</Label>
                  <textarea
                    id="terms"
                    rows={4}
                    value={formData.terms}
                    onChange={(e) => setFormData({ ...formData, terms: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <Label htmlFor="memo">Memo (Internal)</Label>
                  <textarea
                    id="memo"
                    rows={3}
                    value={formData.memo}
                    onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
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
                  <Label htmlFor="discount">Discount ($)</Label>
                  <Input
                    id="discount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.discount}
                    onChange={(e) => setFormData({ ...formData, discount: e.target.value })}
                  />
                </div>
                <div className="flex justify-between">
                  <span>Subtotal after discount:</span>
                  <span>${subtotalAfterDiscount.toFixed(2)}</span>
                </div>
                <div>
                  <Label htmlFor="taxRate">Tax Rate (%)</Label>
                  <Input
                    id="taxRate"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.taxRate}
                    onChange={(e) => setFormData({ ...formData, taxRate: e.target.value })}
                  />
                </div>
                <div className="flex justify-between">
                  <span>Tax:</span>
                  <span>${tax.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total:</span>
                  <span>${total.toFixed(2)}</span>
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
