'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, Plus, Trash2, Eye, EyeOff, Building2, User, ChevronDown, ChevronRight } from 'lucide-react'
import { LineItemDragHandle } from '@/components/documents/line-item-drag-handle'
import Link from 'next/link'
import { ResponsivePage } from '@/components/layout/ResponsivePage'
import { MobileActionBar } from '@/components/layout/MobileActionBar'
import { FastPicker, FastPickerItem } from '@/components/items/FastPicker'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { refreshAccessToken } from '@/lib/auth/client'
import { usePermissions } from '@/hooks/usePermissions'
import { postCreateRedirectPath } from '@/hooks/useDocumentListAccess'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'
import { computePercentOfAbovePrice } from '@/lib/documents/percent-of-above'
import { fetchClientDefaultAddressString } from '@/lib/clients/client-picker-api'
import { useCreateContextPrefill } from '@/src/hooks/useCreateContextPrefill'
import { cnCustomerVisibilityBulkPill } from '@/lib/ui/customer-visibility-bulk-pill'
import { applyBundleSelectionToLines } from '@/lib/bundles/expand-line-items'
import {
  addItemToDocumentBundle,
  removeDocumentLineItem,
} from '@/lib/bundles/document-line-item-actions'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CustomerEstimatePanel } from '@/components/estimates/customer-estimate-panel'
import {
  type CustomerLine,
  collectGroupsFromEditorLines,
  flatLineItemsToCompanyLines,
  mergeCustomerIntoGroups,
  syncCustomerLines,
} from '@/lib/estimates/company-customer-sync'

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
  // Subtotal row
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
  // lineNumber reserved for display; name starts blank for the user to fill in
  void lineNumber
  return [header, createBlankGroupedLineItem(groupId, groupName)]
}

function createInitialEstimateLineItems(): LineItem[] {
  return createManualLineBundle(1)
}

export default function NewEstimatePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions } = usePermissions()
  const clientIdParam = searchParams.get('clientId')
  const requestIdParam = searchParams.get('requestId')
  const jobIdParam = searchParams.get('jobId')

  const { prefillClientId, address: prefillAddress, noAddressWarning, applyDefaultsOnce } =
    useCreateContextPrefill('estimate')
  
  const [loading, setLoading] = useState(false)
  const [nextEstimatePreview, setNextEstimatePreview] = useState<string | null>(null)
  const [nextEstimatePreviewLoading, setNextEstimatePreviewLoading] = useState(true)
  const [nextEstimatePreviewError, setNextEstimatePreviewError] = useState(false)
  const [bulkModeActive, setBulkModeActive] = useState(false)
  const [selectedItemIndices, setSelectedItemIndices] = useState<Set<number>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [clients, setClients] = useState<PickerClient[]>([])
  const [pickerItems, setPickerItems] = useState<FastPickerItem[]>([])
  const [pickerBundles, setPickerBundles] = useState<FastPickerItem[]>([])
  const [lineItems, setLineItems] = useState<LineItem[]>(() => createInitialEstimateLineItems())
  const [optionalItems, setOptionalItems] = useState<LineItem[]>([])
  const [customerLines, setCustomerLines] = useState<CustomerLine[]>([])
  const [estimateLineView, setEstimateLineView] = useState<'company' | 'customer'>('company')
  const [focusedLineIndex, setFocusedLineIndex] = useState<number | null>(null)
  const [isNotesVisibleToClient, setIsNotesVisibleToClient] = useState(true)
  
  const [formData, setFormData] = useState({
    clientId: clientIdParam || '',
    leadId: requestIdParam || '',
    jobId: jobIdParam || '',
    estimateNumber: '',
    title: '',
    jobSiteAddress: '',
    taxRate: '0',
    discount: '0',
    validUntil: '',
    notes: '',
    terms: '',
  })

  const lineItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const pickerInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const optionalItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const optionalPickerInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const jobSiteAddressRef = useRef<string>('')

  useEffect(() => {
    jobSiteAddressRef.current = formData.jobSiteAddress || ''
  }, [formData.jobSiteAddress])

  useEffect(() => {
    fetchClients()
    fetchPickerData()
  }, [])

  // Keep customer bundles in sync with company Line # groups (manually-edited lines stay sticky for good).
  useEffect(() => {
    const companyLines = flatLineItemsToCompanyLines(lineItems)
    setCustomerLines((prev) => syncCustomerLines(companyLines, prev))
  }, [lineItems])

  const loadNextEstimateNumberPreview = useCallback(async () => {
    setNextEstimatePreviewLoading(true)
    setNextEstimatePreviewError(false)
    try {
      let token = localStorage.getItem('accessToken')
      let response = await fetch('/api/estimates/next-number', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 401) {
        const ok = await refreshAccessToken()
        if (!ok) throw new Error('Unauthorized')
        token = localStorage.getItem('accessToken')
        response = await fetch('/api/estimates/next-number', {
          headers: { Authorization: `Bearer ${token}` },
        })
      }
      if (!response.ok) throw new Error('Failed to load next estimate number')
      const data = await response.json()
      setNextEstimatePreview(typeof data.estimateNumber === 'string' ? data.estimateNumber : null)
    } catch (e) {
      console.error('Next estimate number preview:', e)
      setNextEstimatePreviewError(true)
      setNextEstimatePreview(null)
    } finally {
      setNextEstimatePreviewLoading(false)
    }
  }, [])

  useEffect(() => {
    if (formData.estimateNumber.trim() !== '') return
    loadNextEstimateNumberPreview()
  }, [formData.estimateNumber, loadNextEstimateNumberPreview])

  useEffect(() => {
    // Context-aware autofill (from inside Request/Job/Estimate/etc).
    // Only apply once and never overwrite user-entered values.
    applyDefaultsOnce(
      () => {
        const wantsClient = Boolean(prefillClientId && !formData.clientId)
        // Avoid overriding Job context: jobId implies jobSite is fetched from the Job record.
        const wantsAddress = Boolean(prefillAddress && !jobIdParam && !formData.jobSiteAddress)
        return wantsClient || wantsAddress
      },
      () => {
        setFormData((prev) => {
          const addrStr = prefillAddress
            ? `${prefillAddress.street}, ${prefillAddress.city}, ${prefillAddress.state} ${prefillAddress.zipCode}`.replace(
                /\s+,/g,
                ','
              )
            : ''
          return {
            ...prev,
            clientId: prev.clientId || prefillClientId || '',
            jobSiteAddress: prev.jobSiteAddress || (!jobIdParam ? addrStr : ''),
          }
        })
      }
    )
    // Intentionally exclude formData from deps; applyDefaultsOnce guarantees single application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillClientId, prefillAddress, jobIdParam, applyDefaultsOnce])

  useEffect(() => {
    if (!requestIdParam) return
    const fetchRequestContext = async () => {
      try {
        let token = localStorage.getItem('accessToken')
        let response = await fetch(`/api/leads/${requestIdParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (response.status === 401) {
          const ok = await refreshAccessToken()
          if (!ok) return
          token = localStorage.getItem('accessToken')
          response = await fetch(`/api/leads/${requestIdParam}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        }

        if (!response.ok) return
        const data = await response.json()
        const lead = data.lead
        // Requests can be linked to a client via different fields depending on how/when it was created.
        // Prefer convertedToClientId (current flow), then fall back to direct clientId or included client object.
        const resolvedClientId = lead.convertedToClientId || lead.clientId || lead.client?.id || null
        setFormData((prev) => ({
          ...prev,
          leadId: lead.id,
          clientId: resolvedClientId || prev.clientId,
          title: prev.title || `Estimate for ${lead.firstName} ${lead.lastName}`.trim(),
          jobSiteAddress: lead.jobSiteAddress || prev.jobSiteAddress,
          notes: prev.notes || lead.notes || '',
        }))
      } catch (error) {
        console.error('Error loading request context:', error)
      }
    }
    fetchRequestContext()
  }, [requestIdParam])

  useEffect(() => {
    if (!jobIdParam) return
    const fetchJobContext = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        const response = await fetch(`/api/jobs/${jobIdParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) return
        const data = await response.json()
        const job = data?.job
        if (!job?.id) return

        const siteAddress = job.jobSite
          ? `${job.jobSite.street}, ${job.jobSite.city}, ${job.jobSite.state} ${job.jobSite.zipCode}`.replace(/\s+,/g, ',')
          : ''

        setFormData((prev) => ({
          ...prev,
          jobId: job.id,
          clientId: job.client?.id || prev.clientId,
          title: prev.title || `Estimate for ${job.title}`,
          jobSiteAddress: prev.jobSiteAddress || siteAddress,
        }))
      } catch (error) {
        console.error('Error loading job context:', error)
      }
    }
    fetchJobContext()
  }, [jobIdParam])

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

  const handleClientSelect = async (value: string) => {
    setFormData((prev) => ({ ...prev, clientId: value }))
    if (jobIdParam) return
    // Only fill address if user hasn't entered one yet.
    if (jobSiteAddressRef.current.trim()) return
    const addr = await fetchClientDefaultAddressString(value)
    if (!addr) return
    setFormData((prev) => {
      if (prev.clientId !== value) return prev
      if (prev.jobSiteAddress && prev.jobSiteAddress.trim()) return prev
      return { ...prev, jobSiteAddress: addr }
    })
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
      focusLinePickerAt(1)
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
      const result = addItemToDocumentBundle(prev, groupId, createBlankLineItem)
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
        showDescriptionToCustomer: false,
        showCostToCustomer: false,
        showPriceToCustomer: true,
        showTaxToCustomer: true,
        showNotesToCustomer: true,
      }
      if (!row.isSubtotal && row.groupId) {
        blank.groupId = row.groupId
        blank.groupName = row.groupName
      } else {
        const lastHeader = [...prev].reverse().find((item) => item.isGroupHeader && item.groupId)
        if (lastHeader?.groupId) {
          blank.groupId = lastHeader.groupId
          blank.groupName = lastHeader.groupName
        }
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

  const handleItemSelect = async (item: FastPickerItem, lineIndex: number) => {
    const updated = [...lineItems]

    if (item.kind === 'BUNDLE') {
      // Fetch bundle details and expand
      try {
        const token = localStorage.getItem('accessToken')
        // Use bundleId from the FastPickerItem (this is the BundleDefinition ID)
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
          // Fallback if bundle fetch fails
          updated[lineIndex] = {
            ...updated[lineIndex],
            description: item.name,
            quantity: '1',
            unitPrice: item.defaultUnitPrice.toString(),
            unitCost: item.defaultUnitCost?.toString() || '0',
            taxable: item.taxable,
            taxRate: item.taxRate?.toString() || '',
            sourceBundleId: item.bundleId,
            showDescriptionToCustomer: false,
            showNotesToCustomer: true,
          }
        }
      } catch (error) {
        console.error('Error fetching bundle details:', error)
        // Fallback
        updated[lineIndex] = {
          ...updated[lineIndex],
          description: item.name,
          quantity: '1',
          unitPrice: item.defaultUnitPrice.toString(),
          unitCost: item.defaultUnitCost?.toString() || '0',
          taxable: item.taxable,
          taxRate: item.taxRate?.toString() || '',
          sourceBundleId: item.bundleId,
          showDescriptionToCustomer: false,
          showNotesToCustomer: true,
        }
      }
    } else {
      // Single item
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
        // Prefill "Description" from Item.description (QBO SalesDesc/PurchaseDesc).
        // Fallback to Item.notes only when it isn't the QBO import marker.
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

  const handleNextLine = (currentIndex: number) => {
    const nextIndex = currentIndex + 1
    setLineItems((prev) => {
      if (nextIndex < prev.length) return prev
      const current = prev[currentIndex]
      const blank = createBlankLineItem()
      if (current?.groupId && !current.isSubtotal) {
        blank.groupId = current.groupId
        blank.groupName = current.groupName
      } else {
        const lastHeader = [...prev].reverse().find((item) => item.isGroupHeader && item.groupId)
        if (lastHeader?.groupId) {
          blank.groupId = lastHeader.groupId
          blank.groupName = lastHeader.groupName
        }
      }
      return [...prev, blank]
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

  const toggleLineRowVisibility = (index: number) => {
    setLineItems((prev) => {
      const updated = [...prev]
      updated[index] = {
        ...updated[index],
        isVisibleToClient: !(updated[index].isVisibleToClient ?? true),
      }
      return updated
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

  const setGroupLineItemsVisibility = (groupId: string, isVisibleToClient: boolean) => {
    setLineItems((prev) =>
      prev.map((item) =>
        item.groupId === groupId && !item.isGroupHeader ? { ...item, isVisibleToClient } : item
      )
    )
  }

  type VisibilityField = 'showDescriptionToCustomer' | 'showNotesToCustomer' | 'showPriceToCustomer' | 'showCostToCustomer' | 'showTaxToCustomer'
  const setBulkFieldVisibility = (field: VisibilityField, value: boolean) => {
    setLineItems((prev) => prev.map((item, idx) => {
      if (item.isGroupHeader) return item
      if (bulkModeActive && selectedItemIndices.size > 0 && !selectedItemIndices.has(idx)) return item
      return { ...item, [field]: value }
    }))
    // Only apply to optional items when no per-item selection is active
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

  // Optional items (separate section; not included in main totals)
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

  const toggleOptionalRowVisibility = (index: number) => {
    setOptionalItems((prev) => {
      const updated = [...prev]
      updated[index] = {
        ...updated[index],
        isVisibleToClient: !(updated[index].isVisibleToClient ?? true),
      }
      return updated
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

  const setGroupOptionalItemsVisibility = (groupId: string, isVisibleToClient: boolean) => {
    setOptionalItems((prev) =>
      prev.map((item) =>
        item.groupId === groupId && !item.isGroupHeader ? { ...item, isVisibleToClient } : item
      )
    )
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
              groupIdPrefix: 'opt-group-',
              headerExtras: {
                taxable: item.taxable,
                taxRate: item.taxRate?.toString() || '',
                isVisibleToClient: true,
                showDescriptionToCustomer: true,
                showCostToCustomer: false,
                showPriceToCustomer: true,
                showTaxToCustomer: true,
                showNotesToCustomer: false,
              },
            }
          ).then((lines) =>
            lines.map((line) =>
              line.isGroupHeader || !line.groupId ? line : { ...line, isVisibleToClient: true }
            )
          )
          setOptionalItems(newLines)
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
            sourceBundleId: item.bundleId,
            showDescriptionToCustomer: false,
            showNotesToCustomer: true,
          }
        }
      } catch (error) {
        console.error('Error fetching bundle details (optional):', error)
        updated[lineIndex] = {
          ...updated[lineIndex],
          description: item.name,
          quantity: '1',
          unitPrice: item.defaultUnitPrice.toString(),
          unitCost: item.defaultUnitCost?.toString() || '0',
          taxable: item.taxable,
          taxRate: item.taxRate?.toString() || '',
          sourceBundleId: item.bundleId,
          showDescriptionToCustomer: false,
          showNotesToCustomer: true,
        }
      }
    } else {
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
    }

    setOptionalItems(updated)

    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(() => resolve(), 0)
      })
    })
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
          isVisibleToClient: true,
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

  const toggleOptionalFieldVisibility = (index: number, field: 'description' | 'cost' | 'price' | 'tax' | 'notes') => {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.clientId) {
      alert('Please select a client')
      return
    }
    if (!formData.title.trim()) {
      alert('Please enter a title')
      return
    }

    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      
      // Calculate totals (exclude group headers and subtotal rows)
      const subtotal = lineItems.reduce((sum, item) => {
        if (item.isGroupHeader || item.isSubtotal) return sum
        return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')
      }, 0)
      
      const discount = parseFloat(formData.discount || '0')
      const subtotalAfterDiscount = subtotal - discount
      const taxRate = parseFloat(formData.taxRate || '0') / 100
      const tax = subtotalAfterDiscount * taxRate
      const total = subtotalAfterDiscount + tax

      const isBlankLine = (item: any) => {
        const desc = String(item.description || '').trim()
        const qty = parseFloat(item.quantity || '0')
        const price = parseFloat(item.unitPrice || '0')
        const hasMeta = Boolean(item.sourceItemId || item.sourceBundleId || item.groupId)
        return !hasMeta && desc === '' && qty === 0 && price === 0
      }

      // Prepare line items for API
      const apiLineItems = lineItems
        .filter(item => !item.isGroupHeader) // Exclude group headers from API
        .filter(item => item.isSubtotal || !isBlankLine(item)) // Keep subtotal rows even if blank
        .map((item, index) => ({
          description: item.isSubtotal ? 'Subtotal' : item.description,
          quantity: item.isSubtotal ? 0 : parseFloat(item.quantity || '1'),
          unitPrice: item.isSubtotal ? 0 : parseFloat(item.unitPrice || '0'),
          unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
          total: item.isSubtotal ? 0 : parseFloat(item.quantity || '1') * parseFloat(item.unitPrice || '0'),
          sortOrder: index,
          isVisibleToClient: item.isVisibleToClient !== false,
          showDescriptionToCustomer: item.showDescriptionToCustomer,
          showCostToCustomer: item.showCostToCustomer,
          showPriceToCustomer: item.showPriceToCustomer,
          showTaxToCustomer: item.showTaxToCustomer,
          showNotesToCustomer: item.showNotesToCustomer,
          vendorId: item.vendorId || null,
          taxable: item.isSubtotal ? false : item.taxable,
          taxRate: item.taxRate ? parseFloat(item.taxRate) / 100 : null,
          notes: item.notes || null,
          groupId: item.groupId || null,
          sourceItemId: item.sourceItemId || null,
          sourceBundleId: item.sourceBundleId || null,
          isSubtotal: item.isSubtotal || false,
        }))

      const apiOptionalItems = optionalItems
        .filter(item => !item.isGroupHeader)
        .filter(item => !isBlankLine(item))
        .map((item, index) => ({
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

      const response = await fetch('/api/estimates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientId: formData.clientId,
          leadId: formData.leadId || null,
          jobId: formData.jobId || null,
          estimateNumber: formData.estimateNumber || null,
          title: formData.title,
          jobSiteAddress: formData.jobSiteAddress || null,
          subtotal,
          taxRate: taxRate,
          taxAmount: tax,
          discount,
          total,
          validUntil: formData.validUntil || null,
          notes: formData.notes || null,
          isNotesVisibleToClient,
          terms: formData.terms || null,
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
        const errorData = await response.json().catch(() => ({ error: 'Failed to create estimate' }))
        const message =
          errorData.error ||
          (response.status === 409
            ? 'Estimate number already exists. Please use a different estimate number.'
            : 'Failed to create estimate')
        alert(message)
        return
      }

      const data = await response.json()
      router.push(postCreateRedirectPath(permissions, 'estimates', 'estimates.view', data.estimate.id))
    } catch (error) {
      console.error('Error creating estimate:', error)
      alert('Failed to create estimate. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Calculate totals
  const subtotal = lineItems.reduce((sum, item) => {
    if (item.isGroupHeader) return sum
    return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')
  }, 0)

  const optionalSubtotal = optionalItems.reduce((sum, item) => {
    if (item.isGroupHeader) return sum
    return sum + parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')
  }, 0)
  
  const discount = parseFloat(formData.discount || '0')
  const subtotalAfterDiscount = subtotal - discount
  const taxRate = parseFloat(formData.taxRate || '0') / 100
  const tax = subtotalAfterDiscount * taxRate
  const total = subtotalAfterDiscount + tax

  return (
    <ResponsivePage>
      <div className="flex items-center space-x-4">
        <EntityBackButton fallbackHref="/dashboard/estimates" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">New Estimate</h1>
          <p className="mt-2 text-gray-600">Create a new estimate for a client</p>
          {formData.estimateNumber.trim() === '' && (
            <p className="mt-2 text-sm text-gray-700">
              {nextEstimatePreviewLoading ? (
                <span className="text-gray-500">Loading next estimate number…</span>
              ) : nextEstimatePreviewError ? (
                <span className="text-amber-800">
                  Next estimate number will be assigned when you save (preview unavailable).
                </span>
              ) : nextEstimatePreview ? (
                <>
                  Next estimate number:{' '}
                  <span className="font-mono font-semibold text-gray-900">{nextEstimatePreview}</span>
                  <span className="text-gray-500"> (if you leave Estimate # blank)</span>
                </>
              ) : null}
            </p>
          )}
        </div>
      </div>

      {noAddressWarning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Client has no address on file. Job site address was not auto-filled.
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Estimate Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="clientId">Client *</Label>
                  <SearchableClientSelect
                    clients={clients}
                    value={formData.clientId}
                    onSelect={handleClientSelect}
                    placeholder="Select a client..."
                    disabled={Boolean(jobIdParam)}
                  />
                  {jobIdParam && (
                    <p className="mt-1 text-xs text-gray-500">Client is locked because this estimate is being created from a job.</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="estimateNumber">Estimate # (optional)</Label>
                  <Input
                    id="estimateNumber"
                    value={formData.estimateNumber}
                    onChange={(e) => setFormData({ ...formData, estimateNumber: e.target.value })}
                    placeholder={
                      nextEstimatePreview && !formData.estimateNumber.trim()
                        ? `Default: ${nextEstimatePreview}`
                        : 'Leave blank to auto-generate (ex: EST-000123)'
                    }
                  />
                  {formData.estimateNumber.trim() === '' ? (
                    <p className="mt-1 text-xs text-gray-600">
                      {nextEstimatePreviewLoading ? (
                        'Checking next available number…'
                      ) : nextEstimatePreview ? (
                        <>
                          Will be saved as <span className="font-mono font-medium">{nextEstimatePreview}</span> unless
                          you type a custom number above.
                        </>
                      ) : nextEstimatePreviewError ? (
                        'A number will be chosen when you save.'
                      ) : null}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      Using your custom number. Future auto-generated estimates still follow the highest used number.
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    required
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="e.g., Kitchen Remodel Estimate"
                  />
                </div>
                <div>
                  <Label htmlFor="jobSiteAddress">Job Site Address</Label>
                  <Input
                    id="jobSiteAddress"
                    value={formData.jobSiteAddress}
                    onChange={(e) => setFormData({ ...formData, jobSiteAddress: e.target.value })}
                    placeholder="123 Main St, Austin, TX 78701"
                  />
                  {formData.jobSiteAddress.trim() && (
                    <iframe
                      title="Estimate Job Site Map"
                      className="mt-3 h-56 w-full rounded-md border"
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(formData.jobSiteAddress)}&output=embed`}
                    />
                  )}
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
                        Switch between company (detailed / QB) and customer (bundled) estimates
                      </CardDescription>
                    </div>
                    <Tabs
                      value={estimateLineView}
                      onValueChange={(v) => setEstimateLineView(v as 'company' | 'customer')}
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
                  {estimateLineView === 'company' && (
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
                {estimateLineView === 'customer' ? (
                  <CustomerEstimatePanel
                    customerLines={customerLines}
                    onChange={setCustomerLines}
                  />
                ) : (
                <>
                <div className="space-y-2">
                  {lineItems.map((item, index) => {
                    const isGroupHeader = item.isGroupHeader
                    const isInGroup = !!item.groupId && !isGroupHeader
                    const isSubtotalRow = item.isSubtotal

                    // Hide child rows of a collapsed bundle (data stays intact — display only)
                    if (isInGroup && item.groupId && collapsedGroups.has(item.groupId)) {
                      return null
                    }

                    // For subtotal rows: sum items since the previous subtotal
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
                          <div className="flex items-center gap-3">
                            <span className="font-bold text-slate-800">${subtotalDisplay.toFixed(2)}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Insert line below"
                              onClick={() => insertLineItemAfter(index)}
                              className="text-green-600 hover:text-green-800"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeLineItem(index)}
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

                        {/* Item Name with FastPicker */}
                        <div className="line-item-field-wide flex-1 space-y-1">
                          {isGroupHeader ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={item.groupId && collapsedGroups.has(item.groupId) ? 'Expand bundle' : 'Collapse bundle'}
                                onClick={() => {
                                  if (!item.groupId) return
                                  const groupId = item.groupId
                                  setCollapsedGroups((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(groupId)) {
                                      next.delete(groupId)
                                    } else {
                                      next.add(groupId)
                                    }
                                    return next
                                  })
                                }}
                                className="h-8 w-8 shrink-0 p-0"
                              >
                                {item.groupId && collapsedGroups.has(item.groupId) ? (
                                  <ChevronRight className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </Button>
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
                                rows={1}
                                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                                data-col="notes"
                              />
                            </>
                          )}
                        </div>

                        {/* Quantity */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric">
                            <Label className="text-xs text-gray-500 mb-1 block">Quantity</Label>
                            <Input
                              type="number"
                                calculator
                              step="0.01"
                              placeholder="1"
                              value={item.quantity}
                              onChange={(e) => updateLineItem(index, 'quantity', e.target.value)}
                              required
                              data-col="quantity"
                            />
                          </div>
                        )}

                        {/* Unit Price with visibility toggle */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric relative">
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
                        )}

                        {/* Unit Cost with visibility toggle */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric relative">
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
                        )}

                        {/* Tax with visibility toggle */}
                        {!isGroupHeader && (
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
                        )}

                        {/* Total (Quantity × Unit Price) */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric">
                            <Label className="text-xs text-gray-500 mb-1 block">Total</Label>
                            <div className="px-3 py-2 bg-gray-50 rounded border text-right font-medium">
                              ${(parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')).toFixed(2)}
                            </div>
                          </div>
                        )}

                        {/* Insert line / subtotal after this row */}
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
                    onClick={() => {
                      setLineItems(prev => [
                        ...prev,
                        {
                          description: 'Subtotal',
                          quantity: '0',
                          unitPrice: '0',
                          taxable: false,
                          showDescriptionToCustomer: true,
                          showCostToCustomer: false,
                          showPriceToCustomer: true,
                          showTaxToCustomer: false,
                          showNotesToCustomer: false,
                          isSubtotal: true,
                        },
                      ])
                    }}
                    className="border-dashed"
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
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>Optional Items</CardTitle>
                    <CardDescription>Optional items are shown separately and do not affect the total unless added later.</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs shrink-0">
                    <span className="text-gray-500 font-medium self-center">Show to customer:</span>
                    {(['showDescriptionToCustomer', 'showNotesToCustomer', 'showPriceToCustomer', 'showCostToCustomer', 'showTaxToCustomer'] as VisibilityField[]).map((field) => {
                      const labels: Record<VisibilityField, string> = { showDescriptionToCustomer: 'Name', showNotesToCustomer: 'Description', showPriceToCustomer: 'Price', showCostToCustomer: 'Cost', showTaxToCustomer: 'Tax' }
                      const anyVisible = optionalItems.some((li) => !li.isGroupHeader && li[field] !== false)
                      return (
                        <button key={field} type="button"
                          onClick={() => setBulkFieldVisibility(field, !anyVisible)}
                          title={`${anyVisible ? 'Hide' : 'Show'} ${labels[field]} for all optional items`}
                          className={cnCustomerVisibilityBulkPill(anyVisible)}
                        >
                          {anyVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          {labels[field]}
                        </button>
                      )
                    })}
                  </div>
                </div>
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

                    if (isInGroup && item.groupId && collapsedGroups.has(item.groupId)) {
                      return null
                    }

                    return (
                      <div
                        key={index}
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
                              title={isVisible ? 'Hide optional item from customer' : 'Show optional item to customer'}
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

                        {/* Item Name with FastPicker */}
                        <div className="line-item-field-wide flex-1 space-y-1">
                          {isGroupHeader ? (
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={item.groupId && collapsedGroups.has(item.groupId) ? 'Expand bundle' : 'Collapse bundle'}
                                onClick={() => {
                                  if (!item.groupId) return
                                  const groupId = item.groupId
                                  setCollapsedGroups((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(groupId)) {
                                      next.delete(groupId)
                                    } else {
                                      next.add(groupId)
                                    }
                                    return next
                                  })
                                }}
                                className="h-7 w-7 shrink-0 p-0"
                              >
                                {item.groupId && collapsedGroups.has(item.groupId) ? (
                                  <ChevronRight className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </Button>
                              <Input
                                value={item.description}
                                onChange={(e) => updateOptionalItem(index, 'description', e.target.value)}
                                placeholder="Bundle name"
                                className="flex-1 font-semibold"
                                readOnly
                              />
                              <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded">
                                Bundle
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                title="Add item to this bundle (this estimate only)"
                                onClick={() => item.groupId && addOptionalItemToBundle(item.groupId)}
                                className="h-7 text-xs shrink-0"
                              >
                                <Plus className="h-3 w-3 mr-1" />
                                Add item
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setGroupOptionalItemsVisibility(
                                    item.groupId || '',
                                    optionalItems.some((li) => li.groupId === item.groupId && !li.isGroupHeader && li.isVisibleToClient === false)
                                  )
                                }
                                title="Show or hide this whole section for the customer"
                                className="p-1 h-7"
                              >
                                {optionalItems.some((li) => li.groupId === item.groupId && !li.isGroupHeader && li.isVisibleToClient === false) ? (
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
                                  onClick={() => toggleOptionalFieldVisibility(index, 'description')}
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
                                  onClick={() => toggleOptionalFieldVisibility(index, 'notes')}
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

                        {/* Quantity */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric">
                            <Label className="text-xs text-gray-500 mb-1 block">Quantity</Label>
                            <Input
                              type="number"
                                calculator
                              step="0.01"
                              placeholder="1"
                              value={item.quantity}
                              onChange={(e) => updateOptionalItem(index, 'quantity', e.target.value)}
                            />
                          </div>
                        )}

                        {/* Unit Price with visibility toggle */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric relative">
                            <div className="flex items-center gap-1 mb-1">
                              <Label className="text-xs text-gray-500">Price</Label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                tabIndex={-1}
                                onClick={() => toggleOptionalFieldVisibility(index, 'price')}
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
                            />
                          </div>
                        )}

                        {/* Unit Cost with visibility toggle */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric relative">
                            <div className="flex items-center gap-1 mb-1">
                              <Label className="text-xs text-gray-500">Cost</Label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                tabIndex={-1}
                                onClick={() => toggleOptionalFieldVisibility(index, 'cost')}
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
                              className="bg-gray-50"
                            />
                          </div>
                        )}

                        {/* Tax with visibility toggle */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric relative">
                            <div className="flex items-center gap-1 mb-1">
                              <Label className="text-xs text-gray-500">Tax</Label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                tabIndex={-1}
                                onClick={() => toggleOptionalFieldVisibility(index, 'tax')}
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
                        )}

                        {/* Total (Quantity × Unit Price) */}
                        {!isGroupHeader && (
                          <div className="line-item-field-numeric">
                            <Label className="text-xs text-gray-500 mb-1 block">Total</Label>
                            <div className="px-3 py-2 bg-gray-50 rounded border text-right font-medium">
                              ${(parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')).toFixed(2)}
                            </div>
                          </div>
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
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title="Remove line"
                              onClick={() => removeOptionalItem(index)}
                            >
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
                  <Label htmlFor="validUntil">Valid Until</Label>
                  <Input
                    id="validUntil"
                    type="date"
                    value={formData.validUntil}
                    onChange={(e) => setFormData({ ...formData, validUntil: e.target.value })}
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
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Optional Items Subtotal:</span>
                  <span>${optionalSubtotal.toFixed(2)}</span>
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

            <MobileActionBar className="max-lg:mx-0 max-lg:flex-col">
              <Button type="submit" disabled={loading} className="w-full sm:w-auto">
                <Save className="mr-2 h-4 w-4" />
                {loading ? 'Creating...' : 'Create Estimate'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="w-full sm:w-auto">
                Cancel
              </Button>
            </MobileActionBar>
          </div>
        </div>
      </form>
    </ResponsivePage>
  )
}
