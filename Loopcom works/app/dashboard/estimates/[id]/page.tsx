'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Calendar, DollarSign, Mail, User, Building2, FileText, Send, Download, Edit, ChevronDown, ChevronRight, Package, Trash2, RefreshCw, Unlink, Plus, Printer, Copy } from 'lucide-react'
import Link from 'next/link'
import { MobileActionBar } from '@/components/layout/MobileActionBar'
import { ResponsivePage } from '@/components/layout/ResponsivePage'
import { ResponsiveTableContainer } from '@/components/layout/ResponsiveTableContainer'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { DocumentAttachments } from '@/components/common/document-attachments'
import { EstimateMaterialList } from '@/components/estimates/estimate-material-list'
import { CustomerEstimatePanel } from '@/components/estimates/customer-estimate-panel'
import { ContactRecipientPicker } from '@/components/email/contact-recipient-picker'
import { ItemPicker } from '@/components/items/ItemPicker'
import { buildCreateContextQuery } from '@/src/lib/create-context'
import { calculateOrderedSubtotalRows, mergeApprovedOptionalItemsForSubtotals } from '@/lib/documents/subtotals'
import {
  buildCustomerLinesFromGroups,
  flatLineItemsToCompanyLines,
} from '@/lib/estimates/company-customer-sync'
import type { EstimatePdfView } from '@/lib/estimates/estimate-pdf-view'

interface EstimateDetail {
  id: string
  estimateNumber: string
  title: string
  jobSiteAddress: string | null
  status: string
  convertedPercent?: number | null
  conversionProgress?: {
    estimateTotal: string
    invoicedTotal: string
    remainingAmount: string
    convertedPercent: number
    remainingPercent: number
    isFullyInvoiced: boolean
  } | null
  subtotal: string
  taxRate: string
  taxAmount: string
  discount: string
  total: string
  validUntil: string | null
  notes: string | null
  terms: string | null
  isNotesVisibleToClient?: boolean
  createdAt: string
  updatedAt: string
  client: {
    id: string
    name: string
    companyName: string | null
    contacts: Array<{
      id: string
      firstName: string
      lastName: string
      phone: string | null
      email: string | null
    }>
  } | null
  lead: {
    id: string
    firstName: string
    lastName: string
  } | null
  job: {
    id: string
    jobNumber: string
    title: string
  } | null
  lineItems: Array<{
    id: string
    description: string
    quantity: string
    unitPrice: string
    unitCost?: string | null
    notes?: string | null
    total: string
    sortOrder: number
    isVisibleToClient?: boolean
    isSubtotal?: boolean
    groupId: string | null
    group: {
      id: string
      name: string
      sourceBundleId: string | null
      sourceBundleName: string | null
    } | null
    sourceItemId: string | null
    sourceItem: {
      id: string
      name: string
      kind: string
    } | null
  }>
  optionalItems?: Array<{
    id: string
    description: string
    quantity: string
    unitPrice: string
    unitCost?: string | null
    notes?: string | null
    total: string
    sortOrder: number
    isVisibleToClient?: boolean
  }>
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  VIEWED: 'bg-purple-100 text-purple-800',
  ACCEPTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-yellow-100 text-yellow-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
}

export default function EstimateDetailPage() {
  const params = useParams()
  const router = useRouter()
  const estimateId = params.id as string
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [processingGroup, setProcessingGroup] = useState<string | null>(null)
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null)
  const [showItemPicker, setShowItemPicker] = useState(false)
  const [itemPickerGroupId, setItemPickerGroupId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [showBillingModal, setShowBillingModal] = useState(false)
  const [convertingInvoice, setConvertingInvoice] = useState(false)
  const [billingMode, setBillingMode] = useState<'FULL' | 'PERCENTAGE' | 'MANUAL'>('FULL')
  const [billingPercent, setBillingPercent] = useState('50')
  const [selectedLineItemIds, setSelectedLineItemIds] = useState<string[]>([])

  type PerItemMode = 'GLOBAL_PCT' | 'FULL' | 'CUSTOM_PCT' | 'CUSTOM_AMT'
  interface PerItemBilling { mode: PerItemMode; percent?: string; amount?: string }
  const [lineItemBillings, setLineItemBillings] = useState<Record<string, PerItemBilling>>({})

  const setItemBilling = (id: string, patch: Partial<PerItemBilling>) =>
    setLineItemBillings((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const calcLinePreview = (li: { id: string; total: string }, globalPct: number): number => {
    const base = Number(li.total)
    const b = lineItemBillings[li.id]
    if (!b || b.mode === 'GLOBAL_PCT') return base * (globalPct / 100)
    if (b.mode === 'FULL') return base
    if (b.mode === 'CUSTOM_PCT') return base * (Number(b.percent || 0) / 100)
    if (b.mode === 'CUSTOM_AMT') return Number(b.amount || 0)
    return base * (globalPct / 100)
  }
  const [sending, setSending] = useState(false)
  const [showSendModal, setShowSendModal] = useState(false)
  const [selectedRecipientEmails, setSelectedRecipientEmails] = useState<string[]>([])
  const [customEmails, setCustomEmails] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendMessage, setSendMessage] = useState('')
  const [sendPdfView, setSendPdfView] = useState<EstimatePdfView>('customer')
  const [pdfActionModal, setPdfActionModal] = useState<'download' | 'print' | null>(null)
  const [pdfActionView, setPdfActionView] = useState<EstimatePdfView>('customer')
  const [pdfActionBusy, setPdfActionBusy] = useState(false)

  const [approvalInfo, setApprovalInfo] = useState<{
    approveUrl: string
    expiresAt: string | null
    approvals: any[]
    invoiceHistory: any[]
  } | null>(null)
  const [loadingApprovals, setLoadingApprovals] = useState(false)
  const [regeneratingApprovalLink, setRegeneratingApprovalLink] = useState(false)
  const [reimportingLines, setReimportingLines] = useState(false)
  const [activeTab, setActiveTab] = useState<'company' | 'customer' | 'material-list'>('company')

  useEffect(() => {
    fetchEstimate()
  }, [estimateId])

  const fetchApprovals = async () => {
    try {
      setLoadingApprovals(true)
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const res = await fetch(`/api/estimates/${estimateId}/approvals`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      if (data?.approveUrl) setApprovalInfo(data)
    } catch (e) {
      console.error('Failed to fetch estimate approvals:', e)
    } finally {
      setLoadingApprovals(false)
    }
  }

  useEffect(() => {
    if (!estimateId) return
    fetchApprovals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId])

  const handleCopyApprovalLink = async () => {
    const url = approvalInfo?.approveUrl
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      alert('Approval link copied.')
    } catch {
      // Fallback
      prompt('Copy approval link:', url)
    }
  }

  const handleRegenerateApprovalLink = async () => {
    if (!confirm('Regenerate approval link? This will revoke the old link.')) return
    try {
      setRegeneratingApprovalLink(true)
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const res = await fetch(`/api/estimates/${estimateId}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'regenerate' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data?.error || 'Failed to regenerate link')
        return
      }
      setApprovalInfo((prev) =>
        prev ? { ...prev, approveUrl: data.approveUrl, expiresAt: data.expiresAt || null } : prev
      )
    } catch (e) {
      console.error('Regenerate approval link error:', e)
      alert('Failed to regenerate link')
    } finally {
      setRegeneratingApprovalLink(false)
    }
  }

  const fetchEstimate = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/estimates/${estimateId}`, {
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
        console.error('Failed to fetch estimate:', error)
        setEstimate(null)
        setLoading(false)
        return
      }

      const data = await response.json()
      if (data.estimate) {
        setEstimate(data.estimate)
      } else {
        setEstimate(null)
      }
    } catch (error) {
      console.error('Failed to fetch estimate:', error)
      setEstimate(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchPdfHtml = async (print = false, view: EstimatePdfView = 'customer') => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      throw new Error('Not authenticated')
    }

    const qs = new URLSearchParams()
    qs.set('format', 'html')
    qs.set('view', view)
    if (print) qs.set('print', '1')
    const response = await fetch(`/api/estimates/${estimateId}/pdf?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 401) {
      router.push('/auth/login')
      throw new Error('Unauthorized')
    }
    if (!response.ok) {
      throw new Error('Failed to generate PDF')
    }

    return response.text()
  }

  const fetchPdfBlob = async (
    view: EstimatePdfView = 'customer'
  ): Promise<{ blob: Blob; filename: string }> => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      throw new Error('Not authenticated')
    }

    const qs = new URLSearchParams()
    qs.set('download', '1')
    qs.set('view', view)
    const response = await fetch(`/api/estimates/${estimateId}/pdf?${qs.toString()}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 401) {
      router.push('/auth/login')
      throw new Error('Unauthorized')
    }
    if (!response.ok) {
      throw new Error('Failed to generate PDF')
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const cd = response.headers.get('content-disposition') || ''
    const match = /filename=\"?([^\";]+)\"?/i.exec(cd)
    const headerFilename = match?.[1]?.trim()

    const blob = await response.blob()
    const fallbackExt = contentType.includes('pdf') ? 'pdf' : 'html'
    const viewSuffix = view === 'company' ? '-company' : '-customer'
    const fallbackFilename = `Estimate-${estimate?.estimateNumber || estimateId}${viewSuffix}.${fallbackExt}`

    return {
      blob,
      filename: headerFilename || fallbackFilename,
    }
  }

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to delete this bundle group and all its items?')) {
      return
    }

    setProcessingGroup(groupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/estimates/${estimateId}/groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to delete group')
        return
      }

      fetchEstimate()
    } catch (error) {
      console.error('Error deleting group:', error)
      alert('Failed to delete group')
    } finally {
      setProcessingGroup(null)
    }
  }

  const handleUngroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to ungroup these items? They will become regular line items.')) {
      return
    }

    setProcessingGroup(groupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/estimates/${estimateId}/groups/${groupId}/ungroup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to ungroup items')
        return
      }

      fetchEstimate()
    } catch (error) {
      console.error('Error ungrouping:', error)
      alert('Failed to ungroup items')
    } finally {
      setProcessingGroup(null)
    }
  }

  const handleUpdateFromTemplate = async (groupId: string) => {
    if (!confirm('This will replace all items in this bundle group with the current template. Local edits will be lost. Continue?')) {
      return
    }

    setProcessingGroup(groupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/estimates/${estimateId}/groups/${groupId}/update-from-template`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to update from template')
        return
      }

      fetchEstimate()
    } catch (error) {
      console.error('Error updating from template:', error)
      alert('Failed to update from template')
    } finally {
      setProcessingGroup(null)
    }
  }

  const handleAddItemToGroup = (groupId: string) => {
    setItemPickerGroupId(groupId)
    setShowItemPicker(true)
  }

  const handleItemSelectForGroup = async (item: any) => {
    if (!itemPickerGroupId) return

    setAddingToGroup(itemPickerGroupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/estimates/${estimateId}/groups/${itemPickerGroupId}/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          description: item.name + (item.description ? ` - ${item.description}` : ''),
          quantity: 1,
          unitPrice: item.defaultUnitPrice,
          sourceItemId: item.id,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to add item to group')
        return
      }

      fetchEstimate()
      setShowItemPicker(false)
      setItemPickerGroupId(null)
    } catch (error) {
      console.error('Error adding item to group:', error)
      alert('Failed to add item to group')
    } finally {
      setAddingToGroup(null)
    }
  }

  const openPdfActionModal = (action: 'download' | 'print') => {
    setPdfActionView('customer')
    setPdfActionModal(action)
  }

  const confirmPdfAction = async () => {
    if (!pdfActionModal || pdfActionBusy) return
    setPdfActionBusy(true)
    try {
      if (pdfActionModal === 'download') {
        const { blob, filename } = await fetchPdfBlob(pdfActionView)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else {
        const html = await fetchPdfHtml(true, pdfActionView)
        const printWindow = window.open('', '_blank')
        if (!printWindow) {
          alert('Popup blocked. Please allow popups to print.')
          return
        }
        printWindow.document.open()
        printWindow.document.write(html)
        printWindow.document.close()
      }
      setPdfActionModal(null)
    } catch (error) {
      console.error(`${pdfActionModal} estimate PDF error:`, error)
      alert(pdfActionModal === 'download' ? 'Failed to download estimate PDF' : 'Failed to print estimate')
    } finally {
      setPdfActionBusy(false)
    }
  }

  const handleDownloadPDF = async () => {
    openPdfActionModal('download')
  }

  const handlePrint = async () => {
    openPdfActionModal('print')
  }

  const handleDuplicate = async () => {
    setDuplicating(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/estimates/${estimateId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to duplicate estimate')
        return
      }

      if (data?.id) {
        router.push(`/dashboard/estimates/${data.id}`)
      } else {
        router.push('/dashboard/estimates')
      }
    } catch (error) {
      console.error('Duplicate estimate error:', error)
      alert('Failed to duplicate estimate')
    } finally {
      setDuplicating(false)
    }
  }

  const handleReimportLines = async () => {
    if (!confirm('Re-import line items from QuickBooks? This will replace all current line items with the latest structure from QBO (including subtotal rows). This cannot be undone.')) return
    setReimportingLines(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/estimates/${estimateId}/reimport-lines`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to re-import line items.')
        return
      }
      alert(`Done! Replaced with ${data.regularItemCount} item(s) and ${data.subtotalRowsAdded} subtotal row(s) from QuickBooks.`)
      await fetchEstimate()
    } catch (e) {
      console.error('Reimport lines error:', e)
      alert('Failed to re-import line items.')
    } finally {
      setReimportingLines(false)
    }
  }

  const handleOpenConvertToInvoice = () => {
    if (!estimate) return
    const cp = estimate.conversionProgress
    const maxRem = cp ? Math.min(100, Math.max(0, Number(cp.remainingPercent) || 0)) : 100
    if (cp?.isFullyInvoiced) {
      alert('This estimate is fully invoiced. No further conversion is available.')
      return
    }
    setBillingMode('FULL')
    const defaultPct = Math.max(1, Math.min(50, Math.floor(maxRem)))
    setBillingPercent(String(Math.min(defaultPct, Math.max(1, Math.floor(maxRem)))))
    setSelectedLineItemIds(estimate.lineItems.map((li) => li.id))
    // Initialise every non-subtotal line item to the global percentage mode
    const initial: Record<string, PerItemBilling> = {}
    for (const li of estimate.lineItems) {
      if (!li.isSubtotal) initial[li.id] = { mode: 'GLOBAL_PCT' }
    }
    setLineItemBillings(initial)
    setShowBillingModal(true)
  }

  const handleConvertToInvoice = async () => {
    if (!estimate) return
    try {
      setConvertingInvoice(true)

      const mode = billingMode || 'FULL'
      if (mode === 'PERCENTAGE') {
        const pct = Number(billingPercent || 0)
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          alert('Percentage must be between 0 and 100.')
          return
        }
        const maxRem = estimate.conversionProgress
          ? Math.min(100, Math.max(0, Number(estimate.conversionProgress.remainingPercent) || 0))
          : 100
        if (pct > maxRem + 0.0001) {
          alert(
            `That would exceed what is left to invoice. You can bill at most about ${maxRem.toFixed(2)}% more of this estimate's total (additional lines on a new invoice), or reduce the percentage.`,
          )
          return
        }
      }
      if (mode === 'MANUAL' && selectedLineItemIds.length === 0) {
        alert('Select at least one line item to bill.')
        return
      }

      // Persist per-item billing overrides so the invoice new page can read them
      if (mode === 'PERCENTAGE') {
        try {
          sessionStorage.setItem(
            `estimate-convert-billings-${estimate.id}`,
            JSON.stringify(lineItemBillings)
          )
        } catch (_) {}
      }

      // Open a draft invoice prefilled from this estimate
      const qs = new URLSearchParams()
      qs.set('estimateId', estimate.id)
      qs.set('billingMode', mode)
      if (mode === 'PERCENTAGE') {
        qs.set('percentage', String(Number(billingPercent || 0)))
      }
      if (mode === 'MANUAL') {
        qs.set('selectedLineItemIds', selectedLineItemIds.join(','))
      }

      setShowBillingModal(false)
      router.push(`/dashboard/invoices/new?${qs.toString()}`)
    } catch (error) {
      console.error('Open invoice draft error:', error)
      alert('Failed to open invoice draft')
    } finally {
      setConvertingInvoice(false)
    }
  }

  const handleSendEstimate = async () => {
    if (!estimate || sending) return
    setSelectedRecipientEmails([])
    setCustomEmails('')
    setSendSubject(
      estimate.jobSiteAddress
        ? `Estimate for ${estimate.jobSiteAddress}`
        : `Estimate ${estimate.estimateNumber}`
    )
    setSendMessage(`Please review estimate ${estimate.estimateNumber}.`)
    setSendPdfView('customer')
    setShowSendModal(true)
    return
  }

  const submitSendEstimate = async () => {
    if (!estimate || sending) return
    const customEmailList = customEmails
      .split(/[,\s;]+/g)
      .map((v) => v.trim())
      .filter(Boolean)
    const emails = Array.from(new Set([...selectedRecipientEmails, ...customEmailList]))
    if (emails.length === 0) return

    setSending(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/estimates/${estimateId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          emails,
          subject: sendSubject || `Estimate ${estimate.estimateNumber}`,
          message: sendMessage || `Please review estimate ${estimate.estimateNumber}.`,
          view: sendPdfView,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to send estimate email')
        return
      }

      if (Array.isArray(data?.failedRecipients) && data.failedRecipients.length) {
        const failed = data.failedRecipients.map((r: any) => r.recipient || '').filter(Boolean).join(', ')
        alert(`Estimate sent, but failed for: ${failed}`)
      } else {
        alert('Estimate email sent successfully')
      }
      await fetchEstimate()
    } catch (error) {
      console.error('Send estimate error:', error)
      alert('Failed to send estimate email')
    } finally {
      setSending(false)
      setShowSendModal(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading estimate...</p>
        </div>
      </div>
    )
  }

  if (!estimate) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 text-xl font-semibold mb-2">Estimate not found</div>
        <p className="text-gray-600 mb-4">The estimate you're looking for doesn't exist or you don't have permission to view it.</p>
        <Button variant="outline" onClick={() => router.push('/dashboard/estimates')}>
          ← Back to Estimates
        </Button>
      </div>
    )
  }

  const primaryContact = estimate.client?.contacts?.[0] || null
  const optionalItems = (estimate as any).optionalItems || []
  // Split optional items by customer approval status
  const approvedOptionalItems: any[] = Array.isArray(optionalItems) ? optionalItems.filter((i: any) => i.isApproved) : []
  const pendingOptionalItems: any[] = Array.isArray(optionalItems) ? optionalItems.filter((i: any) => !i.isApproved) : []
  const displayLineItems = calculateOrderedSubtotalRows(
    mergeApprovedOptionalItemsForSubtotals((estimate as any).lineItems || [], approvedOptionalItems)
  ).map((item: any) => ({
    ...item,
    total: (item.isSubtotal ? item.calculatedSubtotalTotal : item.total).toString(),
  }))

  const customerLines = (() => {
    const flat = (estimate.lineItems || []).map((li: any) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      unitCost: li.unitCost || '',
      notes: li.notes || '',
      taxable: li.taxable !== false,
      taxRate: li.taxRate || '',
      groupId: li.groupId || undefined,
      groupName: li.group?.name || undefined,
      isGroupHeader: false,
      isSubtotal: li.isSubtotal || false,
    }))

    const withHeaders: any[] = []
    const seen = new Set<string>()
    for (const item of flat) {
      if (item.groupId && item.groupName && !seen.has(item.groupId)) {
        withHeaders.push({
          id: `header-${item.groupId}`,
          description: item.groupName,
          quantity: '1',
          unitPrice: '0',
          groupId: item.groupId,
          groupName: item.groupName,
          isGroupHeader: true,
          taxable: true,
        })
        seen.add(item.groupId)
      }
      withHeaders.push(item)
    }

    const company = flatLineItemsToCompanyLines(withHeaders)
    const meta: Record<string, { customerDescription?: string | null; customerTotal?: string | null; customerEdited?: boolean | null }> = {}
    for (const li of estimate.lineItems || []) {
      if (li.group?.id && !meta[li.group.id]) {
        meta[li.group.id] = {
          customerDescription: (li.group as any).customerDescription,
          customerTotal: (li.group as any).customerTotal,
          customerEdited: (li.group as any).customerEdited,
        }
      }
    }
    return buildCustomerLinesFromGroups(company, meta)
  })()

  const approvedOptionalSubtotal = approvedOptionalItems.reduce((sum: number, item: any) => sum + parseFloat(item.total || '0'), 0)
  const displaySubtotal = parseFloat(estimate.subtotal || '0') + approvedOptionalSubtotal
  const displayDiscount = parseFloat(estimate.discount || '0')
  const displayTaxRate = parseFloat(estimate.taxRate || '0')
  const displayNet = displaySubtotal - displayDiscount
  const displayTaxAmount = Math.round(displayNet * displayTaxRate * 100) / 100
  const displayTotal = Math.round((displayNet + displayTaxAmount) * 100) / 100

  const maxAdditionalBillPct = estimate.conversionProgress
    ? Math.min(100, Math.max(0, Number(estimate.conversionProgress.remainingPercent) || 0))
    : 100

  return (
    <ResponsivePage>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
          <EntityBackButton fallbackHref="/dashboard/estimates" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 break-words sm:text-3xl">{estimate.title}</h1>
            <p className="mt-1 text-sm text-gray-600 sm:text-base">
              {estimate.estimateNumber}{' \u2022 '}Created {formatDate(estimate.createdAt)}
            </p>
          </div>
        </div>
        <MobileActionBar>
          <span className={`px-3 py-1 text-sm rounded-full ${statusColors[estimate.status] || 'bg-gray-100 text-gray-800'}`}>
            {estimate.status === 'CONVERTED' && estimate.convertedPercent != null
              ? estimate.conversionProgress?.isFullyInvoiced
                ? `FULLY INVOICED (${estimate.convertedPercent}%)`
                : `PARTIALLY INVOICED (${estimate.convertedPercent}%)`
              : estimate.status}
          </span>
          <Button
            variant="outline"
            onClick={() => {
              const clientId = estimate?.client?.id || null
              router.push(
                `/dashboard/estimates/new${buildCreateContextQuery({
                  clientId,
                  sourceType: 'estimate',
                  sourceId: estimateId,
                })}`
              )
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            New Estimate
          </Button>
          <Button variant="outline" onClick={handleDownloadPDF}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
          <Button variant="outline" onClick={handlePrint}>
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
          <Button variant="outline" onClick={handleDuplicate} disabled={duplicating}>
            <Copy className="mr-2 h-4 w-4" />
            {duplicating ? 'Duplicating...' : 'Duplicate'}
          </Button>
          {estimate?.estimateNumber?.startsWith('QB-EST-') && (
            <Button
              variant="outline"
              onClick={handleReimportLines}
              disabled={reimportingLines}
              title="Re-fetch line items from QuickBooks (adds subtotal rows)"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${reimportingLines ? 'animate-spin' : ''}`} />
              {reimportingLines ? 'Re-importing...' : 'Sync Lines from QBO'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleOpenConvertToInvoice}
            disabled={!estimate?.client || estimate.conversionProgress?.isFullyInvoiced === true}
            title={
              !estimate?.client
                ? 'Link a client before converting to an invoice.'
                : estimate.conversionProgress?.isFullyInvoiced
                  ? 'Estimate is fully invoiced.'
                  : 'Create another invoice from this estimate (progressive billing).'
            }
          >
            <DollarSign className="mr-2 h-4 w-4" />
            Convert to Invoice
          </Button>
          <Button variant="outline" onClick={() => router.push(`/dashboard/estimates/${estimateId}/edit`)}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button onClick={handleSendEstimate} disabled={sending}>
            <Send className="mr-2 h-4 w-4" />
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </MobileActionBar>
      </div>

      <div className="border-b">
        <nav className="flex space-x-8">
          {[
            { id: 'company' as const, label: 'Company' },
            { id: 'customer' as const, label: 'Customer' },
            { id: 'material-list' as const, label: 'Material List' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`border-b-2 px-1 py-4 text-sm font-medium ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <Dialog open={showSendModal} onOpenChange={setShowSendModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Estimate</DialogTitle>
            <DialogDescription>
              Choose which contacts should receive this estimate, or add a custom email below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>PDF to send</Label>
              <div className="space-y-2 rounded-md border p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="send-pdf-view"
                    className="mt-1"
                    checked={sendPdfView === 'customer'}
                    onChange={() => setSendPdfView('customer')}
                  />
                  <span>
                    <span className="font-medium">Customer estimate</span>
                    <span className="block text-xs text-muted-foreground">
                      Bundled Line # view (default)
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="send-pdf-view"
                    className="mt-1"
                    checked={sendPdfView === 'company'}
                    onChange={() => setSendPdfView('company')}
                  />
                  <span>
                    <span className="font-medium">Company estimate</span>
                    <span className="block text-xs text-muted-foreground">
                      Detailed line items (internal / QB style)
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Recipients</Label>
              <ContactRecipientPicker
                clientId={estimate.client?.id || null}
                onSelectionChange={(emails) => setSelectedRecipientEmails(emails)}
                manageContactsHref={estimate.client ? `/dashboard/clients/${estimate.client.id}/edit` : undefined}
              />
            </div>

            <div className="space-y-2">
              <Label>Additional email(s) (optional)</Label>
              <Input
                value={customEmails}
                onChange={(e) => setCustomEmails(e.target.value)}
                placeholder="someone-else@email.com"
              />
              <p className="text-xs text-muted-foreground">You can enter multiple emails separated by commas.</p>
            </div>

            <div className="space-y-2">
              <Label>Subject</Label>
              <Input value={sendSubject} onChange={(e) => setSendSubject(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Message</Label>
              <Input value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendModal(false)} disabled={sending}>
              Cancel
            </Button>
            <Button
              onClick={() => submitSendEstimate()}
              disabled={
                sending ||
                (selectedRecipientEmails.length === 0 && !customEmails.trim())
              }
            >
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pdfActionModal != null}
        onOpenChange={(open) => {
          if (!open && !pdfActionBusy) setPdfActionModal(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pdfActionModal === 'print' ? 'Print estimate' : 'Download PDF'}
            </DialogTitle>
            <DialogDescription>
              Choose which estimate PDF to {pdfActionModal === 'print' ? 'print' : 'download'}.
              Customer is the default.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-md border p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="pdf-action-view"
                className="mt-1"
                checked={pdfActionView === 'customer'}
                onChange={() => setPdfActionView('customer')}
              />
              <span>
                <span className="font-medium">Customer estimate</span>
                <span className="block text-xs text-muted-foreground">
                  Bundled Line # view (default)
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="pdf-action-view"
                className="mt-1"
                checked={pdfActionView === 'company'}
                onChange={() => setPdfActionView('company')}
              />
              <span>
                <span className="font-medium">Company estimate</span>
                <span className="block text-xs text-muted-foreground">
                  Detailed line items (internal / QB style)
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPdfActionModal(null)}
              disabled={pdfActionBusy}
            >
              Cancel
            </Button>
            <Button onClick={confirmPdfAction} disabled={pdfActionBusy}>
              {pdfActionBusy
                ? pdfActionModal === 'print'
                  ? 'Preparing…'
                  : 'Downloading…'
                : pdfActionModal === 'print'
                  ? 'Print'
                  : 'Download'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 md:grid-cols-3">
        {activeTab === 'material-list' ? (
          <div className="md:col-span-3">
            <EstimateMaterialList estimateId={estimateId} />
          </div>
        ) : null}
        {activeTab === 'customer' ? (
          <div className="md:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle>Customer estimate</CardTitle>
                <CardDescription>
                  Bundled Line # view derived from company groups. Edit from the Edit page Customer tab.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CustomerEstimatePanel customerLines={customerLines} readOnly />
              </CardContent>
            </Card>
          </div>
        ) : null}
        {activeTab === 'company' ? (
        <>
        <div className="md:col-span-2 space-y-6">
          {/* Line Items */}
          <Card>
            <CardHeader>
              <CardTitle>Company estimate</CardTitle>
              <CardDescription>
                Detailed items that sync to QuickBooks. Switch to the Customer tab for bundled view.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveTableContainer>
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-4 font-semibold">Item</th>
                      <th className="text-left py-2 px-4 font-semibold">Description</th>
                      <th className="text-right py-2 px-4 font-semibold">Quantity</th>
                      <th className="text-right py-2 px-4 font-semibold">Unit Price</th>
                      <th className="text-right py-2 px-4 font-semibold">Vendor Cost</th>
                      <th className="text-right py-2 px-4 font-semibold">Margin</th>
                      <th className="text-right py-2 px-4 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Group line items by groupId
                      const groupedItems = new Map<string, any[]>()
                      const ungroupedItems: any[] = []

                      for (const item of displayLineItems) {
                        if (item.groupId && item.group) {
                          if (!groupedItems.has(item.groupId)) {
                            groupedItems.set(item.groupId, [])
                          }
                          groupedItems.get(item.groupId)!.push(item)
                        } else {
                          ungroupedItems.push(item)
                        }
                      }

                      const rows: JSX.Element[] = []

                      // Render grouped items
                      for (const [groupId, items] of groupedItems.entries()) {
                        const group = items[0].group!
                        const groupTotal = items.reduce((sum, item) => sum + parseFloat(item.total), 0)
                        const isExpanded = !collapsedGroups.has(groupId)

                        rows.push(
                          <tr key={`group-${groupId}`} className="border-b bg-gray-50">
                            <td className="py-3 px-4">
                              <div className="flex items-center justify-between">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = new Set(collapsedGroups)
                                    if (isExpanded) {
                                      next.add(groupId)
                                    } else {
                                      next.delete(groupId)
                                    }
                                    setCollapsedGroups(next)
                                  }}
                                  className="flex items-center space-x-2 hover:text-primary"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                  <Package className="h-4 w-4" />
                                  <span className="font-semibold">{group.name}</span>
                                  <span className="text-xs text-gray-500">(Bundle)</span>
                                </button>
                                <div className="flex items-center space-x-1">
                                  {group.sourceBundleId && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleUpdateFromTemplate(groupId)}
                                      disabled={processingGroup === groupId}
                                      title="Update from template"
                                    >
                                      <RefreshCw className={`h-3 w-3 ${processingGroup === groupId ? 'animate-spin' : ''}`} />
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleUngroup(groupId)}
                                    disabled={processingGroup === groupId}
                                    title="Ungroup items"
                                  >
                                    <Unlink className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleDeleteGroup(groupId)}
                                    disabled={processingGroup === groupId}
                                    title="Delete group"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4"></td>
                            <td className="py-3 px-4 text-right"></td>
                            <td className="py-3 px-4 text-right"></td>
                            <td className="py-3 px-4 text-right"></td>
                            <td className="py-3 px-4 text-right"></td>
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(groupTotal)}
                            </td>
                          </tr>
                        )

                        if (isExpanded) {
                          items.forEach((item) => {
                            const unitCost = item.unitCost ? parseFloat(item.unitCost) : 0
                            const unitPrice = parseFloat(item.unitPrice)
                            const qty = parseFloat(item.quantity)
                            const marginTotal = (unitPrice - unitCost) * qty
                            const isVisibleToClient = item.isVisibleToClient ?? true
                            rows.push(
                              <tr
                                key={item.id}
                                className={`border-b bg-gray-50/50 ${!isVisibleToClient ? 'opacity-70' : ''}`}
                              >
                                <td className="py-3 px-4 pl-8 whitespace-pre-wrap break-words">
                                  {item.description}
                                  {item.isApproved && (
                                    <span className="ml-1 text-xs rounded bg-green-100 border border-green-200 px-1.5 py-0.5 text-green-700">add-on</span>
                                  )}
                                  {!isVisibleToClient && (
                                    <span className="ml-2 text-xs text-gray-500">(Hidden from client)</span>
                                  )}
                                </td>
                                <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                                <td className="py-3 px-4 text-right">{item.quantity}</td>
                                <td className="py-3 px-4 text-right">{formatCurrency(unitPrice)}</td>
                                <td className="py-3 px-4 text-right">{formatCurrency(unitCost)}</td>
                                <td className="py-3 px-4 text-right">{formatCurrency(marginTotal)}</td>
                                <td className="py-3 px-4 text-right">
                                  {formatCurrency(parseFloat(item.total))}
                                </td>
                              </tr>
                            )
                          })
                          // Add "Add Item" row
                          rows.push(
                            <tr key={`add-item-${groupId}`} className="border-b bg-gray-50/50">
                              <td colSpan={7} className="py-2 px-4 pl-8">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleAddItemToGroup(groupId)}
                                  disabled={addingToGroup === groupId}
                                  className="text-xs"
                                >
                                  <Plus className="h-3 w-3 mr-1" />
                                  {addingToGroup === groupId ? 'Adding...' : 'Add Item to Bundle'}
                                </Button>
                              </td>
                            </tr>
                          )
                        }
                      }

                      // Render ungrouped items (with subtotal rows)
                      ungroupedItems.forEach((item) => {
                        if (item.isSubtotal) {
                          rows.push(
                            <tr key={item.id} className="border-b bg-slate-50">
                              <td colSpan={6} className="py-2 px-4 text-right text-sm font-semibold text-slate-700">
                                Subtotal
                              </td>
                              <td className="py-2 px-4 text-right font-bold text-slate-800">
                                {formatCurrency(parseFloat(item.total || '0'))}
                              </td>
                            </tr>
                          )
                          return
                        }
                        const unitCost = item.unitCost ? parseFloat(item.unitCost) : 0
                        const unitPrice = parseFloat(item.unitPrice)
                        const qty = parseFloat(item.quantity)
                        const marginTotal = (unitPrice - unitCost) * qty
                        const isVisibleToClient = item.isVisibleToClient ?? true
                        rows.push(
                          <tr key={item.id} className={`border-b ${!isVisibleToClient ? 'bg-gray-50' : ''}`}>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">
                              {item.description}
                              {item.isApproved && (
                                <span className="ml-1 text-xs rounded bg-green-100 border border-green-200 px-1.5 py-0.5 text-green-700">add-on</span>
                              )}
                              {!isVisibleToClient && (
                                <span className="ml-2 text-xs text-gray-500">(Hidden from client)</span>
                              )}
                            </td>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                            <td className="py-3 px-4 text-right">{item.quantity}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(unitPrice)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(unitCost)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(marginTotal)}</td>
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(parseFloat(item.total))}
                            </td>
                          </tr>
                        )
                      })

                      return rows
                    })()}
                  </tbody>
                </table>
              </ResponsiveTableContainer>
            </CardContent>
          </Card>

          {/* Pending Optional Items */}
          {pendingOptionalItems.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Optional Items</CardTitle>
                <CardDescription>Optional items are not included in the estimate total unless approved by the customer.</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveTableContainer>
                  <table className="w-full min-w-[720px]">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-4 font-semibold">Item</th>
                        <th className="text-left py-2 px-4 font-semibold">Description</th>
                        <th className="text-right py-2 px-4 font-semibold">Quantity</th>
                        <th className="text-right py-2 px-4 font-semibold">Unit Price</th>
                        <th className="text-right py-2 px-4 font-semibold">Vendor Cost</th>
                        <th className="text-right py-2 px-4 font-semibold">Margin</th>
                        <th className="text-right py-2 px-4 font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingOptionalItems.map((item: any) => {
                        const unitCost = item.unitCost ? parseFloat(item.unitCost) : 0
                        const unitPrice = parseFloat(item.unitPrice || '0')
                        const qty = parseFloat(item.quantity || '0')
                        const marginTotal = (unitPrice - unitCost) * qty
                        const isVisibleToClient = item.isVisibleToClient ?? true
                        return (
                          <tr key={item.id} className={`border-b ${!isVisibleToClient ? 'bg-gray-50' : ''}`}>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">
                              {item.description}
                              {!isVisibleToClient && (
                                <span className="ml-2 text-xs text-gray-500">(Hidden from client)</span>
                              )}
                            </td>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                            <td className="py-3 px-4 text-right">{item.quantity}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(unitPrice)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(unitCost)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(marginTotal)}</td>
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(parseFloat(item.total || '0'))}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </ResponsiveTableContainer>
              </CardContent>
            </Card>
          )}

          {/* Notes & Terms */}
          {(estimate.notes || estimate.terms) && (
            <div className="grid gap-6 md:grid-cols-2">
              {estimate.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      Notes
                      {estimate.isNotesVisibleToClient === false && (
                        <span className="ml-2 text-xs text-gray-500">(Hidden from client)</span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-700 whitespace-pre-wrap">{estimate.notes}</p>
                  </CardContent>
                </Card>
              )}
              {estimate.terms && (
                <Card>
                  <CardHeader>
                    <CardTitle>Terms & Conditions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-700 whitespace-pre-wrap">{estimate.terms}</p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Subtotal:</span>
                <span className="font-semibold">{formatCurrency(displaySubtotal)}</span>
              </div>
              {pendingOptionalItems.length > 0 && (
                <div className="flex justify-between text-gray-500 text-sm">
                  <span>Pending Optional Items:</span>
                  <span>{formatCurrency(pendingOptionalItems.reduce((s: number, i: any) => s + parseFloat(i.total || '0'), 0))}</span>
                </div>
              )}
              {parseFloat(estimate.discount) > 0 && (
                <div className="flex justify-between text-red-600">
                  <span>Discount:</span>
                  <span>-{formatCurrency(parseFloat(estimate.discount))}</span>
                </div>
              )}
              {parseFloat(estimate.taxRate) > 0 && (
                <>
                  <div className="flex justify-between text-gray-600">
                    <span>Tax ({parseFloat(estimate.taxRate) * 100}%):</span>
                    <span>{formatCurrency(displayTaxAmount)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-lg font-bold border-t pt-3">
                <span>Total:</span>
                <span>{formatCurrency(displayTotal)}</span>
              </div>
            </CardContent>
          </Card>

          {estimate.conversionProgress && Number(estimate.conversionProgress.invoicedTotal) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Invoicing progress</CardTitle>
                <CardDescription>
                  Each conversion creates a new invoice. Percentages are an additional portion of the estimate total (same as line scaling), not a running cumulative cap in the form field.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Estimate total</span>
                  <span className="font-medium">{formatCurrency(Number(estimate.conversionProgress.estimateTotal))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Invoiced so far</span>
                  <span className="font-medium">
                    {formatCurrency(Number(estimate.conversionProgress.invoicedTotal))}{' '}
                    <span className="text-gray-500">(~{estimate.conversionProgress.convertedPercent}%)</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Remaining</span>
                  <span className="font-medium text-amber-800">
                    {formatCurrency(Number(estimate.conversionProgress.remainingAmount))}{' '}
                    <span className="text-gray-500">(~{Number(estimate.conversionProgress.remainingPercent).toFixed(1)}%)</span>
                  </span>
                </div>
                {estimate.conversionProgress.isFullyInvoiced && (
                  <p className="text-xs text-green-700 font-medium pt-1">Fully invoiced — no further conversion.</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Approvals */}
          <Card>
            <CardHeader>
              <CardTitle>Approvals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {loadingApprovals && <div className="text-sm text-gray-600">Loading approval status...</div>}
              {!loadingApprovals && approvalInfo?.approveUrl && (
                <>
                  <div className="text-sm text-gray-700">
                    Public approval link (customer, no login):
                  </div>
                  <div className="flex gap-2">
                    <Input value={approvalInfo.approveUrl} readOnly />
                    <Button type="button" variant="outline" onClick={handleCopyApprovalLink}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRegenerateApprovalLink}
                      disabled={regeneratingApprovalLink}
                    >
                      {regeneratingApprovalLink ? 'Regenerating...' : 'Regenerate Link'}
                    </Button>
                  </div>

                  <div className="text-sm text-gray-700">
                    Approved items: <strong>{(approvalInfo.approvals || []).length}</strong>
                  </div>
                  {(approvalInfo.approvals || []).slice(0, 6).map((a: any) => (
                    <div key={a.id} className="rounded border p-2 text-sm">
                      <div className="font-medium">{a.item?.description || a.estimateLineItemId}</div>
                      <div className="text-gray-600">
                        {a.approvedByName ? `Approved by ${a.approvedByName}` : 'Approved'}{' '}
                        {a.approvedAt ? `\u2022 ${new Date(a.approvedAt).toLocaleString()}` : ''}
                      </div>
                    </div>
                  ))}
                  {(approvalInfo.approvals || []).length > 6 && (
                    <div className="text-xs text-gray-500">
                      Showing 6 of {(approvalInfo.approvals || []).length} approved items.
                    </div>
                  )}

                  <div className="text-sm text-gray-700">
                    Invoiced from approvals: <strong>{(approvalInfo.invoiceHistory || []).length}</strong>
                  </div>
                  {(approvalInfo.invoiceHistory || []).slice(0, 6).map((h: any) => (
                    <div key={h.id} className="rounded border p-2 text-sm">
                      <div className="font-medium">
                        {h.invoice?.invoiceNumber || h.invoiceId}
                      </div>
                      <div className="text-gray-600">
                        {h.createdAt ? `Created ${new Date(h.createdAt).toLocaleString()}` : ''}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {!loadingApprovals && !approvalInfo?.approveUrl && (
                <div className="text-sm text-gray-600">
                  Approval link will be generated when the estimate is sent (or when PDF is generated).
                </div>
              )}
            </CardContent>
          </Card>

          {/* Client Information */}
          {estimate.client && (
            <Card>
              <CardHeader>
                <CardTitle>Client</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Link href={`/dashboard/clients/${estimate.client.id}`} className="text-primary hover:underline">
                    <Building2 className="inline h-4 w-4 mr-2" />
                    {estimate.client.name}
                  </Link>
                  {estimate.client.companyName && (
                    <p className="text-sm text-gray-600 mt-1">{estimate.client.companyName}</p>
                  )}
                </div>
                {primaryContact && (
                  <div className="text-sm text-gray-600">
                    <User className="inline h-4 w-4 mr-2" />
                    {primaryContact.firstName} {primaryContact.lastName}
                    {primaryContact.email && (
                      <p className="mt-1">
                        <Mail className="inline h-3 w-3 mr-1" />
                        {primaryContact.email}
                      </p>
                    )}
                    {primaryContact.phone && (
                      <p>
                        <FileText className="inline h-3 w-3 mr-1" />
                        {primaryContact.phone}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Job Address - displayed prominently below Client */}
          {estimate.jobSiteAddress && (
            <Card>
              <CardHeader>
                <CardTitle>Job Address</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700">{estimate.jobSiteAddress}</p>
                <iframe
                  title="Estimate Job Site Map"
                  className="mt-3 h-48 w-full rounded-md border"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://maps.google.com/maps?q=${encodeURIComponent(estimate.jobSiteAddress)}&output=embed`}
                />
              </CardContent>
            </Card>
          )}

          {/* Lead Information */}
          {estimate.lead && (
            <Card>
              <CardHeader>
                <CardTitle>Request</CardTitle>
              </CardHeader>
              <CardContent>
                <Link href={`/dashboard/requests/${estimate.lead.id}`} className="text-primary hover:underline">
                  {estimate.lead.firstName} {estimate.lead.lastName}
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Job Information */}
          {estimate.job && (
            <Card>
              <CardHeader>
                <CardTitle>Job</CardTitle>
              </CardHeader>
              <CardContent>
                <Link href={`/dashboard/jobs/${estimate.job.id}`} className="text-primary hover:underline">
                  {estimate.job.jobNumber} - {estimate.job.title}
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Created:</span>
                <span>{formatDate(estimate.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Last Updated:</span>
                <span>{formatDate(estimate.updatedAt)}</span>
              </div>
              {estimate.validUntil && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Valid Until:</span>
                  <span className={new Date(estimate.validUntil) < new Date() ? 'text-red-600 font-semibold' : ''}>
                    {formatDate(estimate.validUntil)}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentAttachments entityType="estimate" entityId={estimateId} />
            </CardContent>
          </Card>

        </div>
        </>
        ) : null}
      </div>

      {/* Item Picker for adding items to groups */}
      {showItemPicker && (
        <ItemPicker
          onSelect={handleItemSelectForGroup}
          onClose={() => {
            setShowItemPicker(false)
            setItemPickerGroupId(null)
          }}
        />
      )}

      <Dialog open={showBillingModal} onOpenChange={setShowBillingModal}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>Create Invoice from Estimate</DialogTitle>
            <DialogDescription>
              Choose how much additional amount to bill on a new invoice (percent is an extra slice of the estimate
              total, not the running total). Per-item overrides let you mix percentages on the same invoice.
              {estimate.conversionProgress != null && (
                <span className="mt-2 block text-xs font-normal text-muted-foreground">
                  About {Number(estimate.conversionProgress.remainingPercent).toFixed(1)}% of the estimate remains to
                  invoice ({formatCurrency(Number(estimate.conversionProgress.remainingAmount))}).
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {/* ── Billing mode selector ── */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input type="radio" id="bill-full" checked={billingMode === 'FULL'} onChange={() => setBillingMode('FULL')} />
                <Label htmlFor="bill-full">
                  {maxAdditionalBillPct >= 99.99
                    ? 'Full amount (100% of estimate)'
                    : `Full remaining (~${maxAdditionalBillPct.toFixed(1)}% of estimate)`}
                </Label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input type="radio" id="bill-percentage" checked={billingMode === 'PERCENTAGE'} onChange={() => setBillingMode('PERCENTAGE')} />
                <Label htmlFor="bill-percentage">Percentage</Label>
                <Input
                  className="w-24"
                  type="number"
                  min={1}
                  max={Math.max(1, maxAdditionalBillPct)}
                  step={1}
                  value={billingPercent}
                  onChange={(e) => setBillingPercent(e.target.value)}
                  disabled={billingMode !== 'PERCENTAGE'}
                />
                <span className="text-sm text-gray-600">
                  % additional (max ~{maxAdditionalBillPct.toFixed(1)}% — override per item below)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input type="radio" id="bill-manual" checked={billingMode === 'MANUAL'} onChange={() => setBillingMode('MANUAL')} />
                <Label htmlFor="bill-manual">Manual Selection (Line Items)</Label>
              </div>
            </div>

            {/* ── PERCENTAGE: per-item controls ── */}
            {billingMode === 'PERCENTAGE' && estimate && (() => {
              const globalPct = Math.max(
                0,
                Math.min(maxAdditionalBillPct, Number(billingPercent || 50)),
              )
              const billableLines = estimate.lineItems.filter((li) => !li.isSubtotal)
              const invoiceTotal = billableLines.reduce((sum, li) => sum + calcLinePreview(li, globalPct), 0)

              return (
                <div className="space-y-2 rounded-lg border bg-gray-50 p-3">
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <span>Line item</span>
                    <span>Est. total → Invoice</span>
                  </div>

                  {billableLines.map((li) => {
                    const b = lineItemBillings[li.id] || { mode: 'GLOBAL_PCT' as PerItemMode }
                    const preview = calcLinePreview(li, globalPct)
                    const baseTotal = Number(li.total)

                    return (
                      <div key={li.id} className="rounded border bg-white p-2 space-y-2">
                        {/* Description + totals row */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{li.description || '—'}</div>
                            <div className="text-xs text-gray-400">Qty {li.quantity} × ${Number(li.unitPrice).toFixed(2)}</div>
                          </div>
                          <div className="shrink-0 text-right text-sm">
                            <span className="text-gray-400">${baseTotal.toFixed(2)}</span>
                            <span className="mx-1 text-gray-300">→</span>
                            <span className="font-semibold text-green-700">${preview.toFixed(2)}</span>
                          </div>
                        </div>

                        {/* Mode buttons */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {([
                            { label: `${globalPct}% (default)`, value: 'GLOBAL_PCT' },
                            { label: '100%', value: 'FULL' },
                            { label: 'Custom %', value: 'CUSTOM_PCT' },
                            { label: 'Custom $', value: 'CUSTOM_AMT' },
                          ] as { label: string; value: PerItemMode }[]).map(({ label, value }) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setItemBilling(li.id, { mode: value })}
                              className={`rounded px-2 py-0.5 text-xs font-medium border transition-colors ${
                                b.mode === value
                                  ? 'bg-blue-600 text-white border-blue-600'
                                  : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                              }`}
                            >
                              {label}
                            </button>
                          ))}

                          {b.mode === 'CUSTOM_PCT' && (
                            <div className="flex items-center gap-1">
                              <Input
                                className="h-6 w-20 text-xs"
                                type="number"
                                min={0}
                                max={100}
                                step={1}
                                placeholder="e.g. 75"
                                value={b.percent ?? ''}
                                onChange={(e) => setItemBilling(li.id, { percent: e.target.value })}
                              />
                              <span className="text-xs text-gray-500">%</span>
                            </div>
                          )}
                          {b.mode === 'CUSTOM_AMT' && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-gray-500">$</span>
                              <Input
                                className="h-6 w-24 text-xs"
                                type="number"
                                min={0}
                                step={0.01}
                                placeholder="e.g. 500"
                                value={b.amount ?? ''}
                                onChange={(e) => setItemBilling(li.id, { amount: e.target.value })}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                    <span>Invoice total</span>
                    <span className="text-green-700">
                      {invoiceTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                    </span>
                  </div>
                </div>
              )
            })()}

            {/* ── MANUAL: checkbox selection ── */}
            {billingMode === 'MANUAL' && (
              <div className="max-h-64 space-y-2 overflow-auto rounded border p-3">
                {estimate?.lineItems.map((li) => (
                  <div key={li.id} className="flex items-center justify-between gap-3 rounded border p-2">
                    <div className="text-sm">
                      <div className="font-medium">{li.description}</div>
                      <div className="text-gray-500">
                        Qty {li.quantity}{' • '}${Number(li.unitPrice).toFixed(2)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">${Number(li.total).toFixed(2)}</span>
                      <Checkbox
                        checked={selectedLineItemIds.includes(li.id)}
                        onCheckedChange={(checked) =>
                          setSelectedLineItemIds((prev) =>
                            checked ? [...prev, li.id] : prev.filter((id) => id !== li.id)
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="border-t pt-3">
            <Button variant="outline" onClick={() => setShowBillingModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleConvertToInvoice} disabled={convertingInvoice}>
              {convertingInvoice ? 'Creating...' : 'Create Invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ResponsivePage>
  )
}
