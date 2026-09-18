'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Calendar, DollarSign, User, Building2, FileText, Send, Download, Edit, CheckCircle, AlertCircle, Clock, ChevronDown, ChevronRight, Package, Trash2, RefreshCw, Unlink, Plus, Printer, Copy, CreditCard, Pencil, Eye } from 'lucide-react'
import Link from 'next/link'
import {
  getCustomPaymentLabel,
  getCustomPaymentUiMethod,
  isCustomPayment,
} from '@/lib/payments/custom-payment'
import { MobileActionBar } from '@/components/layout/MobileActionBar'
import { ResponsivePage } from '@/components/layout/ResponsivePage'
import { ResponsiveTableContainer } from '@/components/layout/ResponsiveTableContainer'
import { ItemPicker } from '@/components/items/ItemPicker'
import { Checkbox } from '@/components/ui/checkbox'
import { DocumentAttachments } from '@/components/common/document-attachments'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ContactRecipientPicker } from '@/components/email/contact-recipient-picker'
import { CustomerEstimatePanel } from '@/components/estimates/customer-estimate-panel'
import {
  buildCustomerLinesFromGroups,
  flatLineItemsToCompanyLines,
} from '@/lib/estimates/company-customer-sync'
import type { InvoicePdfView } from '@/lib/invoices/invoice-pdf-view'

interface InvoiceDetail {
  id: string
  invoiceNumber: string
  title: string
  status: string
  subtotal: string
  taxRate: string
  taxAmount: string
  discount: string
  total: string
  balance: string
  paidAmount: string
  invoiceDate: string
  dueDate: string | null
  sentAt: string | null
  paidAt: string | null
  notes: string | null
  terms: string | null
  memo: string | null
  jobSiteAddress?: string | null
  estimateId?: string | null
  progressBillingMode?: string | null
  progressBillingPercent?: string | null
  paymentToken?: string | null
  isBillRest?: boolean
  createdAt: string
  updatedAt: string
  client: {
    id: string
    name: string
    companyName: string | null
    email?: string | null
    contacts: Array<{
      id: string
      firstName: string
      lastName: string
      phone: string | null
      email: string | null
    }>
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
    notes?: string | null
    total: string
    sortOrder: number
    groupId: string | null
    group: {
      id: string
      name: string
      sourceBundleId: string | null
      sourceBundleName: string | null
      customerDescription?: string | null
      customerTotal?: string | null
      customerEdited?: boolean | null
    } | null
    sourceItemId: string | null
    sourceItem: {
      id: string
      name: string
      kind: string
    } | null
    isSubtotal?: boolean
  }>
  optionalItems?: Array<{
    id: string
    description: string
    quantity: string
    unitPrice: string
    notes?: string | null
    total: string
    sortOrder: number
    isVisibleToClient?: boolean
  }>
  payments: Array<{
    id: string
    amount: string
    method: string
    status: string
    processedAt: string | null
    reference: string | null
    provider: string | null
    notes: string | null
  }>
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  VIEWED: 'bg-purple-100 text-purple-800',
  PARTIAL: 'bg-yellow-100 text-yellow-800',
  PAID: 'bg-green-100 text-green-800',
  OVERDUE: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
}

export default function InvoiceDetailPage() {
  const params = useParams()
  const router = useRouter()
  const invoiceId = params.id as string
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [processingGroup, setProcessingGroup] = useState<string | null>(null)
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null)
  const [showItemPicker, setShowItemPicker] = useState(false)
  const [itemPickerGroupId, setItemPickerGroupId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState(false)
  const [creatingPaymentLink, setCreatingPaymentLink] = useState(false)
  const [billRest, setBillRest] = useState(false)
  const [sending, setSending] = useState(false)
  const [showSendModal, setShowSendModal] = useState(false)
  const [selectedRecipientEmails, setSelectedRecipientEmails] = useState<string[]>([])
  const [customEmails, setCustomEmails] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendMessage, setSendMessage] = useState('')
  const [activeTab, setActiveTab] = useState<'company' | 'customer'>('company')
  const [pdfActionModal, setPdfActionModal] = useState<'download' | 'print' | 'view' | null>(null)
  const [pdfActionView, setPdfActionView] = useState<InvoicePdfView>('customer')
  const [pdfActionBusy, setPdfActionBusy] = useState(false)

  // Add Payment modal state
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [addPaymentAmount, setAddPaymentAmount] = useState('')
  const [addPaymentDate, setAddPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [addPaymentMethod, setAddPaymentMethod] = useState<'CHECK' | 'QUICK_PAY' | 'OTHER'>('CHECK')
  const [addPaymentOtherLabel, setAddPaymentOtherLabel] = useState('')
  const [addPaymentReference, setAddPaymentReference] = useState('')
  const [addPaymentSaving, setAddPaymentSaving] = useState(false)
  const [addPaymentError, setAddPaymentError] = useState('')

  // Edit Payment modal state
  const [editPaymentId, setEditPaymentId] = useState<string | null>(null)
  const [editPaymentAmount, setEditPaymentAmount] = useState('')
  const [editPaymentDate, setEditPaymentDate] = useState('')
  const [editPaymentMethod, setEditPaymentMethod] = useState<'CHECK' | 'QUICK_PAY' | 'OTHER'>('CHECK')
  const [editPaymentOtherLabel, setEditPaymentOtherLabel] = useState('')
  const [editPaymentReference, setEditPaymentReference] = useState('')
  const [editPaymentIsCustom, setEditPaymentIsCustom] = useState(true)
  const [editPaymentMethodLabel, setEditPaymentMethodLabel] = useState('')
  const [editPaymentSaving, setEditPaymentSaving] = useState(false)
  const [editPaymentError, setEditPaymentError] = useState('')
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null)
  const [showApplyCreditModal, setShowApplyCreditModal] = useState(false)
  const [availableCredits, setAvailableCredits] = useState<
    Array<{ id: string; creditMemoNumber: string; remainingCredit: number }>
  >([])
  const [creditsLoading, setCreditsLoading] = useState(false)
  const [applyCreditId, setApplyCreditId] = useState('')
  const [applyCreditAmount, setApplyCreditAmount] = useState('')
  const [applyCreditBusy, setApplyCreditBusy] = useState(false)

  // QuickBooks ACH (hosted) UI state
  const [qboAchLoading, setQboAchLoading] = useState<boolean>(false)
  const [qboAchPublicUrl, setQboAchPublicUrl] = useState<string>('')
  const [qboAchHostedUrl, setQboAchHostedUrl] = useState<string>('')
  const [qboAchIntentStatus, setQboAchIntentStatus] = useState<string>('')
  const [qboAchError, setQboAchError] = useState<string>('')

  useEffect(() => {
    fetchInvoice()
  }, [invoiceId])

  useEffect(() => {
    if (!invoice?.id) return
    fetchQboAchStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id])

  useEffect(() => {
    if (!invoice?.client?.id) {
      setAvailableCredits([])
      return
    }
    if (parseFloat(invoice.balance || '0') <= 0) {
      setAvailableCredits([])
      return
    }
    void prefetchAvailableCredits()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id, invoice?.client?.id, invoice?.balance])

  const fetchInvoice = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/invoices/${invoiceId}`, {
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
        console.error('Failed to fetch invoice:', error)
        setInvoice(null)
        setLoading(false)
        return
      }

      const data = await response.json()
      if (data.invoice) {
        setInvoice(data.invoice)
        setBillRest(Boolean(data.invoice.isBillRest))
      } else {
        setInvoice(null)
      }
    } catch (error) {
      console.error('Failed to fetch invoice:', error)
      setInvoice(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchQboAchStatus = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token || !invoice) return
      setQboAchLoading(true)
      const res = await fetch(`/api/payments/qbo/status?invoiceId=${encodeURIComponent(invoice.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return
      setQboAchIntentStatus(String(data?.latest?.status || ''))
      setQboAchHostedUrl(String(data?.latest?.hostedUrl || ''))
      setQboAchPublicUrl(
        data?.latest?.publicToken ? `${window.location.origin}/pay/invoice/${data.latest.publicToken}` : ''
      )
    } finally {
      setQboAchLoading(false)
    }
  }

  const handleCreateQboAchLink = async () => {
    if (!invoice) return
    setQboAchError('')
    setQboAchLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch('/api/payments/qbo/ach/create-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ invoiceId: invoice.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setQboAchError(data.error || 'Failed to create ACH payment link')
        return
      }
      setQboAchPublicUrl(String(data.publicUrl || ''))
      setQboAchHostedUrl(String(data.hostedUrl || ''))
      setQboAchIntentStatus('LINK_CREATED')
    } catch (e: any) {
      setQboAchError(e?.message || 'Failed to create ACH payment link')
    } finally {
      setQboAchLoading(false)
    }
  }

  const handleUngroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to ungroup these items? They will become regular line items.')) {
      return
    }

    setProcessingGroup(groupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/invoices/${invoiceId}/groups/${groupId}/ungroup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to ungroup items')
        return
      }

      // Refresh invoice
      fetchInvoice()
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
      const response = await fetch(`/api/invoices/${invoiceId}/groups/${groupId}/update-from-template`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to update from template')
        return
      }

      // Refresh invoice
      fetchInvoice()
    } catch (error) {
      console.error('Error updating from template:', error)
      alert('Failed to update from template')
    } finally {
      setProcessingGroup(null)
    }
  }

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to delete this bundle group and all its items?')) {
      return
    }

    setProcessingGroup(groupId)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/invoices/${invoiceId}/groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        alert(error.error || 'Failed to delete group')
        return
      }

      // Refresh invoice
      fetchInvoice()
    } catch (error) {
      console.error('Error deleting group:', error)
      alert('Failed to delete group')
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
      const response = await fetch(`/api/invoices/${invoiceId}/groups/${itemPickerGroupId}/items`, {
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

      // Refresh invoice
      fetchInvoice()
      setShowItemPicker(false)
      setItemPickerGroupId(null)
    } catch (error) {
      console.error('Error adding item to group:', error)
      alert('Failed to add item to group')
    } finally {
      setAddingToGroup(null)
    }
  }

  const fetchPdfHtml = async (print = false, view: InvoicePdfView = 'customer') => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      throw new Error('Not authenticated')
    }

    const qs = new URLSearchParams()
    qs.set('format', 'html')
    qs.set('view', view)
    if (print) qs.set('print', '1')
    const response = await fetch(`/api/invoices/${invoiceId}/pdf?${qs.toString()}`, {
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

  const fetchPdfBlob = async (view: InvoicePdfView = 'customer'): Promise<{ blob: Blob; filename: string }> => {
    const token = localStorage.getItem('accessToken')
    if (!token) {
      router.push('/auth/login')
      throw new Error('Not authenticated')
    }

    const response = await fetch(`/api/invoices/${invoiceId}/pdf?download=1&view=${view}`, {
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
    const fallbackFilename = `Invoice-${invoice?.invoiceNumber || invoiceId}-${view}.${fallbackExt}`

    return {
      blob,
      filename: headerFilename || fallbackFilename,
    }
  }

  const openPdfActionModal = (mode: 'download' | 'print' | 'view') => {
    setPdfActionView('customer')
    setPdfActionModal(mode)
  }

  const confirmPdfAction = async () => {
    if (!pdfActionModal) return
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
        const html = await fetchPdfHtml(pdfActionModal === 'print', pdfActionView)
        const w = window.open('', '_blank')
        if (!w) {
          alert('Please allow popups to view/print the PDF')
          return
        }
        w.document.write(html)
        w.document.close()
      }
      setPdfActionModal(null)
    } catch (error) {
      console.error(`${pdfActionModal} invoice PDF error:`, error)
      alert(
        pdfActionModal === 'download'
          ? 'Failed to download invoice PDF'
          : pdfActionModal === 'print'
            ? 'Failed to print invoice'
            : 'Failed to view invoice PDF'
      )
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

  const handleViewPDF = async () => {
    openPdfActionModal('view')
  }

  const prefetchAvailableCredits = async () => {
    if (!invoice?.client?.id) return
    setCreditsLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(
        `/api/credit-memos?clientId=${invoice.client.id}&limit=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) {
        setAvailableCredits([])
        return
      }
      const data = await res.json()
      const credits = (data.creditMemos || [])
        .filter((cm: any) => Number(cm.remainingCredit || 0) > 0 && cm.status !== 'VOID')
        .map((cm: any) => ({
          id: cm.id,
          creditMemoNumber: cm.creditMemoNumber,
          remainingCredit: Number(cm.remainingCredit || 0),
        }))
        .sort((a: { remainingCredit: number }, b: { remainingCredit: number }) => b.remainingCredit - a.remainingCredit)
      setAvailableCredits(credits)
    } catch (e) {
      console.error(e)
      setAvailableCredits([])
    } finally {
      setCreditsLoading(false)
    }
  }

  const selectCreditForApply = (creditId: string) => {
    if (!invoice) return
    const cm = availableCredits.find((c) => c.id === creditId)
    setApplyCreditId(creditId)
    if (cm) {
      setApplyCreditAmount(
        String(Math.min(cm.remainingCredit, parseFloat(invoice.balance || '0')))
      )
    }
  }

  const openApplyCreditModal = async (preferredCreditId?: string) => {
    if (!invoice?.client?.id) return
    let list = availableCredits
    if (!list.length) {
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(
          `/api/credit-memos?clientId=${invoice.client.id}&limit=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!res.ok) {
          alert('Failed to load credit memos')
          return
        }
        const data = await res.json()
        list = (data.creditMemos || [])
          .filter((cm: any) => Number(cm.remainingCredit || 0) > 0 && cm.status !== 'VOID')
          .map((cm: any) => ({
            id: cm.id,
            creditMemoNumber: cm.creditMemoNumber,
            remainingCredit: Number(cm.remainingCredit || 0),
          }))
          .sort(
            (a: { remainingCredit: number }, b: { remainingCredit: number }) =>
              b.remainingCredit - a.remainingCredit
          )
        setAvailableCredits(list)
      } catch (e) {
        console.error(e)
        alert('Failed to load credit memos')
        return
      }
    }
    const first = list.find((c) => c.id === preferredCreditId) || list[0]
    setApplyCreditId(first?.id || '')
    setApplyCreditAmount(
      first
        ? String(Math.min(first.remainingCredit, parseFloat(invoice.balance || '0')))
        : ''
    )
    setShowApplyCreditModal(true)
  }

  const submitApplyCredit = async (opts?: { creditId?: string; amount?: number | null }) => {
    const creditId = opts?.creditId || applyCreditId
    if (!creditId || applyCreditBusy || !invoice) return
    const amount =
      opts?.amount != null
        ? opts.amount
        : applyCreditAmount
          ? Number(applyCreditAmount)
          : null
    setApplyCreditBusy(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/credit-memos/${creditId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          invoiceId,
          amount,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to apply credit')
        return
      }
      setShowApplyCreditModal(false)
      await fetchInvoice()
      await prefetchAvailableCredits()
    } catch (e) {
      console.error(e)
      alert('Failed to apply credit')
    } finally {
      setApplyCreditBusy(false)
    }
  }

  const totalAvailableCredit = availableCredits.reduce((sum, c) => sum + c.remainingCredit, 0)
  const invoiceBalanceNum = invoice ? parseFloat(invoice.balance || '0') : 0
  const quickApplyCredit = availableCredits[0]
  const quickApplyAmount =
    quickApplyCredit && invoiceBalanceNum > 0
      ? Math.min(quickApplyCredit.remainingCredit, invoiceBalanceNum)
      : 0

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
        router.push(`/dashboard/invoices/${data.id}`)
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

  const handlePayNow = async () => {
    if (!invoice || parseFloat(invoice.balance) <= 0) return

    setCreatingPaymentLink(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/invoices/${invoice.id}/portal-pay-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.portalUrl) {
        alert(data.error || 'Unable to open payment portal')
        return
      }

      window.open(data.portalUrl, '_blank', 'noopener,noreferrer')
      await fetchInvoice()
    } catch (error) {
      console.error('Open payment portal error:', error)
      alert('Failed to open payment portal')
    } finally {
      setCreatingPaymentLink(false)
    }
  }

  const handleBillRestLink = async () => {
    if (!invoice || parseFloat(invoice.balance) <= 0) return

    setCreatingPaymentLink(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/payments/sola/link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          invoiceId: invoice.id,
          billRest,
          returnUrl: `${window.location.origin}/portal/pay/${invoice.id}?token=${invoice.paymentToken || ''}&invoices=1`,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.paymentLink) {
        alert(data.error || 'Unable to create payment link')
        return
      }

      window.open(data.paymentLink, '_blank', 'noopener,noreferrer')
      await fetchInvoice()
    } catch (error) {
      console.error('Create payment link error:', error)
      alert('Failed to create payment link')
    } finally {
      setCreatingPaymentLink(false)
    }
  }

  const handleAddPaymentSubmit = async () => {
    if (!invoice) return
    setAddPaymentError('')
    const amount = parseFloat(addPaymentAmount)
    if (!addPaymentAmount || isNaN(amount) || amount <= 0) {
      setAddPaymentError('Please enter a valid amount.')
      return
    }
    const balance = parseFloat(invoice.balance)
    if (amount > balance) {
      setAddPaymentError(`Amount cannot exceed the balance of $${balance.toFixed(2)}.`)
      return
    }
    if (addPaymentMethod === 'OTHER' && !addPaymentOtherLabel.trim()) {
      setAddPaymentError('Please enter a payment type name.')
      return
    }
    if (!addPaymentDate) {
      setAddPaymentError('Please enter a payment date.')
      return
    }
    const parsedPaymentDate = new Date(addPaymentDate)
    if (Number.isNaN(parsedPaymentDate.getTime())) {
      setAddPaymentError('Please enter a valid payment date.')
      return
    }
    setAddPaymentSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          method: addPaymentMethod,
          methodLabel: addPaymentMethod === 'OTHER' ? addPaymentOtherLabel.trim() : undefined,
          amount,
          paidAt: addPaymentDate,
          reference: addPaymentReference.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAddPaymentError(data.error || 'Failed to record payment.')
        return
      }
      setShowAddPayment(false)
      setAddPaymentAmount('')
      setAddPaymentDate(new Date().toISOString().split('T')[0])
      setAddPaymentMethod('CHECK')
      setAddPaymentOtherLabel('')
      setAddPaymentReference('')
      await fetchInvoice()
    } catch {
      setAddPaymentError('Failed to record payment. Please try again.')
    } finally {
      setAddPaymentSaving(false)
    }
  }

  function openEditPayment(payment: {
    id: string
    amount: string
    method: string
    processedAt: string | null
    reference: string | null
    provider: string | null
    notes: string | null
    status: string
    solaTransactionId?: string | null
    providerPaymentId?: string | null
  }) {
    const custom = isCustomPayment(payment)
    setEditPaymentId(payment.id)
    setEditPaymentIsCustom(custom)
    setEditPaymentAmount(parseFloat(payment.amount).toFixed(2))
    setEditPaymentDate(
      payment.processedAt
        ? new Date(payment.processedAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0]
    )
    setEditPaymentMethodLabel(
      [payment.method, payment.provider].filter(Boolean).join(' · ') || payment.method
    )
    if (custom) {
      const uiMethod = getCustomPaymentUiMethod(payment)
      setEditPaymentMethod(uiMethod)
      setEditPaymentOtherLabel(uiMethod === 'OTHER' ? getCustomPaymentLabel(payment) : '')
    } else {
      setEditPaymentMethod('OTHER')
      setEditPaymentOtherLabel('')
    }
    setEditPaymentReference(payment.reference || '')
    setEditPaymentError('')
  }

  const handleEditPaymentSubmit = async () => {
    if (!editPaymentId || !invoice) return
    setEditPaymentError('')
    const amount = parseFloat(editPaymentAmount)
    if (!editPaymentAmount || isNaN(amount) || amount <= 0) {
      setEditPaymentError('Please enter a valid amount.')
      return
    }
    if (editPaymentIsCustom && editPaymentMethod === 'OTHER' && !editPaymentOtherLabel.trim()) {
      setEditPaymentError('Please enter a payment type name.')
      return
    }
    if (!editPaymentDate) {
      setEditPaymentError('Please enter a payment date.')
      return
    }
    const parsedDate = new Date(editPaymentDate)
    if (Number.isNaN(parsedDate.getTime())) {
      setEditPaymentError('Please enter a valid payment date.')
      return
    }
    setEditPaymentSaving(true)
    try {
      const token = localStorage.getItem('accessToken')
      const body: Record<string, unknown> = {
        amount,
        paidAt: editPaymentDate,
        reference: editPaymentReference.trim() || null,
      }
      if (editPaymentIsCustom) {
        body.method = editPaymentMethod
        body.methodLabel = editPaymentMethod === 'OTHER' ? editPaymentOtherLabel.trim() : undefined
      }
      const res = await fetch(`/api/payments/${editPaymentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEditPaymentError(data.error || 'Failed to update payment.')
        return
      }
      setEditPaymentId(null)
      await fetchInvoice()
    } catch {
      setEditPaymentError('Failed to update payment. Please try again.')
    } finally {
      setEditPaymentSaving(false)
    }
  }

  const handleDeletePayment = async (payment: { id: string; amount: string; method: string }) => {
    const confirmed = window.confirm(
      `Delete this ${formatCurrency(parseFloat(payment.amount))} ${payment.method} payment?\n\n` +
        'This removes it from TrimPro and recalculates the invoice balance. Gateway/QuickBooks side may still need a separate void/refund.'
    )
    if (!confirmed) return

    setDeletingPaymentId(payment.id)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/payments/${payment.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to delete payment.')
        return
      }
      await fetchInvoice()
    } catch {
      alert('Failed to delete payment.')
    } finally {
      setDeletingPaymentId(null)
    }
  }

  const handleSendInvoice = async () => {
    if (!invoice || sending) return
    setSelectedRecipientEmails([])
    setCustomEmails('')
    setSendSubject(
      invoice.jobSiteAddress
        ? `Invoice for ${invoice.jobSiteAddress}`
        : `Invoice ${invoice.invoiceNumber}`
    )
    setSendMessage(`Please review and pay invoice ${invoice.invoiceNumber}.`)
    setShowSendModal(true)
    return
  }

  const submitSendInvoice = async () => {
    if (!invoice || sending) return
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

      const response = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          emails,
          subject: sendSubject || `Invoice ${invoice.invoiceNumber}`,
          message: sendMessage || `Please review and pay invoice ${invoice.invoiceNumber}.`,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to send invoice email')
        return
      }

      alert('Invoice email sent successfully')
      await fetchInvoice()
    } catch (error) {
      console.error('Send invoice error:', error)
      alert('Failed to send invoice email')
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
          <p className="mt-4 text-gray-600">Loading invoice...</p>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <div className="text-red-600 text-xl font-semibold mb-2">Invoice not found</div>
        <p className="text-gray-600 mb-4">The invoice you're looking for doesn't exist or you don't have permission to view it.</p>
        <Button variant="outline" onClick={() => router.push('/dashboard/invoices')}>
          ← Back to Invoices
        </Button>
      </div>
    )
  }

  const primaryContact = invoice.client?.contacts?.[0] || null
  const isOverdue = invoice.status === 'OVERDUE' || (invoice.dueDate && new Date(invoice.dueDate) < new Date() && parseFloat(invoice.balance) > 0)
  const optionalItems = (invoice as any).optionalItems || []
  const optionalItemsSubtotal = Array.isArray(optionalItems)
    ? optionalItems.reduce((sum: number, item: any) => sum + parseFloat(item.total || '0'), 0)
    : 0

  const customerLines = (() => {
    const flat = (invoice.lineItems || []).map((li) => ({
      id: li.id,
      description: li.description,
      quantity: String(li.quantity ?? '1'),
      unitPrice: String(li.unitPrice ?? '0'),
      notes: li.notes || '',
      taxable: true,
      groupId: li.groupId || undefined,
      groupName: li.group?.name || undefined,
      isGroupHeader: false,
      isSubtotal: Boolean(li.isSubtotal),
    }))
    const withHeaders: any[] = []
    const seen = new Set<string>()
    for (const item of flat) {
      if (item.groupId && !seen.has(item.groupId)) {
        withHeaders.push({
          id: `header-${item.groupId}`,
          description: item.groupName || '',
          quantity: '1',
          unitPrice: '0',
          groupId: item.groupId,
          groupName: item.groupName || '',
          isGroupHeader: true,
          taxable: true,
        })
        seen.add(item.groupId)
      }
      withHeaders.push(item)
    }
    const company = flatLineItemsToCompanyLines(withHeaders)
    const meta: Record<
      string,
      { customerDescription?: string | null; customerTotal?: string | null; customerEdited?: boolean | null }
    > = {}
    for (const li of invoice.lineItems || []) {
      if (li.group?.id && !meta[li.group.id]) {
        meta[li.group.id] = {
          customerDescription: li.group.customerDescription,
          customerTotal: li.group.customerTotal,
          customerEdited: li.group.customerEdited,
        }
      }
    }
    return buildCustomerLinesFromGroups(company, meta)
  })()

  return (
    <ResponsivePage>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
          <EntityBackButton fallbackHref="/dashboard/invoices" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 break-words sm:text-3xl">{invoice.title}</h1>
            <p className="mt-1 text-sm text-gray-600 sm:text-base">
              {invoice.invoiceNumber}{' \u2022 '}Created {formatDate(invoice.createdAt)}
              {isOverdue && (
                <span className="ml-2 text-red-600 font-semibold flex items-center">
                  <AlertCircle className="h-4 w-4 mr-1" />
                  Overdue
                </span>
              )}
            </p>
          </div>
        </div>
        <MobileActionBar>
          <span className={`px-3 py-1 text-sm rounded-full ${statusColors[invoice.status] || 'bg-gray-100 text-gray-800'}`}>
            {invoice.status}
          </span>
          <Button variant="outline" onClick={handleViewPDF}>
            <Eye className="mr-2 h-4 w-4" />
            View PDF
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
          <Button
            variant="outline"
            onClick={() => router.push(`/dashboard/credit-memos/new?invoiceId=${invoiceId}`)}
          >
            <FileText className="mr-2 h-4 w-4" />
            Create Credit Memo
          </Button>
          {parseFloat(invoice.balance) > 0 && (
            <Button
              variant={totalAvailableCredit > 0 ? 'default' : 'outline'}
              onClick={() => openApplyCreditModal()}
              disabled={creditsLoading}
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              {totalAvailableCredit > 0
                ? `Apply Credit (${formatCurrency(Math.min(totalAvailableCredit, parseFloat(invoice.balance)))})`
                : creditsLoading
                  ? 'Checking credits...'
                  : 'Apply Credit'}
            </Button>
          )}
          <Button variant="outline" onClick={() => router.push(`/dashboard/invoices/${invoiceId}/edit`)}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
          {parseFloat(invoice.balance) > 0 && (
            <>
              <Button onClick={handlePayNow} disabled={creatingPaymentLink}>
                <CreditCard className="mr-2 h-4 w-4" />
                {creatingPaymentLink ? 'Preparing...' : 'Pay Now'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setAddPaymentAmount(invoice.balance)
                  setAddPaymentDate(new Date().toISOString().split('T')[0])
                  setAddPaymentMethod('CHECK')
                  setAddPaymentOtherLabel('')
                  setAddPaymentReference('')
                  setAddPaymentError('')
                  setShowAddPayment(true)
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Payment
              </Button>
            </>
          )}
          <Button onClick={handleSendInvoice} disabled={sending}>
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

      <Dialog
        open={pdfActionModal != null}
        onOpenChange={(open) => {
          if (!open && !pdfActionBusy) setPdfActionModal(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pdfActionModal === 'print'
                ? 'Print invoice'
                : pdfActionModal === 'view'
                  ? 'View PDF'
                  : 'Download PDF'}
            </DialogTitle>
            <DialogDescription>
              Choose which invoice PDF to{' '}
              {pdfActionModal === 'print' ? 'print' : pdfActionModal === 'view' ? 'view' : 'download'}.
              Customer is the default.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-md border p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="invoice-pdf-action-view"
                className="mt-1"
                checked={pdfActionView === 'customer'}
                onChange={() => setPdfActionView('customer')}
              />
              <span>
                <span className="font-medium">Customer invoice</span>
                <span className="block text-xs text-muted-foreground">
                  Bundled Line # view (default)
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="invoice-pdf-action-view"
                className="mt-1"
                checked={pdfActionView === 'company'}
                onChange={() => setPdfActionView('company')}
              />
              <span>
                <span className="font-medium">Company invoice</span>
                <span className="block text-xs text-muted-foreground">
                  Detailed line items (QuickBooks)
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
                  : pdfActionModal === 'view'
                    ? 'Opening…'
                    : 'Downloading…'
                : pdfActionModal === 'print'
                  ? 'Print'
                  : pdfActionModal === 'view'
                    ? 'View'
                    : 'Download'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Payment Modal */}
      <Dialog open={showAddPayment} onOpenChange={setShowAddPayment}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Payment</DialogTitle>
            <DialogDescription>
              Record a manual payment for invoice {invoice?.invoiceNumber}. This will update the invoice and sync to QuickBooks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="add-payment-amount">Amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <Input
                  id="add-payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="pl-7"
                  placeholder="0.00"
                  value={addPaymentAmount}
                  onChange={(e) => setAddPaymentAmount(e.target.value)}
                />
              </div>
              {invoice && (
                <p className="text-xs text-gray-500">Balance due: ${parseFloat(invoice.balance).toFixed(2)}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-payment-date">Payment Date</Label>
              <Input
                id="add-payment-date"
                type="date"
                value={addPaymentDate}
                onChange={(e) => setAddPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Payment Type</Label>
              <div className="flex flex-col gap-2">
                {(['CHECK', 'QUICK_PAY', 'OTHER'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={addPaymentMethod === m}
                      onChange={() => setAddPaymentMethod(m)}
                      className="accent-blue-600"
                    />
                    <span className="text-sm font-medium">
                      {m === 'CHECK' ? 'Check' : m === 'QUICK_PAY' ? 'QuickPay' : 'Other'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {addPaymentMethod === 'OTHER' && (
              <div className="space-y-1">
                <Label htmlFor="add-payment-other">Payment Type Name</Label>
                <Input
                  id="add-payment-other"
                  placeholder="e.g. Cash, Zelle, Venmo..."
                  value={addPaymentOtherLabel}
                  onChange={(e) => setAddPaymentOtherLabel(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="add-payment-reference">Reference Number</Label>
              <Input
                id="add-payment-reference"
                placeholder="e.g. check number, transaction ID..."
                value={addPaymentReference}
                onChange={(e) => setAddPaymentReference(e.target.value)}
              />
            </div>
            {addPaymentError && (
              <p className="text-sm text-red-600">{addPaymentError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddPayment(false)} disabled={addPaymentSaving}>
              Cancel
            </Button>
            <Button onClick={handleAddPaymentSubmit} disabled={addPaymentSaving}>
              {addPaymentSaving ? 'Saving...' : 'Save Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Payment Modal */}
      <Dialog open={Boolean(editPaymentId)} onOpenChange={(open) => { if (!open) setEditPaymentId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Payment</DialogTitle>
            <DialogDescription>
              {editPaymentIsCustom
                ? 'Update the details of this recorded payment.'
                : 'Update amount, date, or reference. Gateway payment type is kept as-is.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="edit-payment-amount">Amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <Input
                  id="edit-payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="pl-7"
                  placeholder="0.00"
                  value={editPaymentAmount}
                  onChange={(e) => setEditPaymentAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-payment-date">Payment Date</Label>
              <Input
                id="edit-payment-date"
                type="date"
                value={editPaymentDate}
                onChange={(e) => setEditPaymentDate(e.target.value)}
              />
            </div>
            {editPaymentIsCustom ? (
              <>
                <div className="space-y-1">
                  <Label>Payment Type</Label>
                  <div className="flex flex-col gap-2">
                    {(['CHECK', 'QUICK_PAY', 'OTHER'] as const).map((m) => (
                      <label key={m} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          checked={editPaymentMethod === m}
                          onChange={() => setEditPaymentMethod(m)}
                          className="accent-blue-600"
                        />
                        <span className="text-sm font-medium">
                          {m === 'CHECK' ? 'Check' : m === 'QUICK_PAY' ? 'QuickPay' : 'Other'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                {editPaymentMethod === 'OTHER' && (
                  <div className="space-y-1">
                    <Label htmlFor="edit-payment-other">Payment Type Name</Label>
                    <Input
                      id="edit-payment-other"
                      placeholder="e.g. Cash, Zelle, Venmo..."
                      value={editPaymentOtherLabel}
                      onChange={(e) => setEditPaymentOtherLabel(e.target.value)}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-1">
                <Label>Payment Type</Label>
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {editPaymentMethodLabel || 'Gateway / imported payment'}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="edit-payment-reference">Reference Number</Label>
              <Input
                id="edit-payment-reference"
                placeholder="Check #, transaction ID, etc."
                value={editPaymentReference}
                onChange={(e) => setEditPaymentReference(e.target.value)}
              />
            </div>
            {editPaymentError && (
              <p className="text-sm text-red-600">{editPaymentError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPaymentId(null)} disabled={editPaymentSaving}>
              Cancel
            </Button>
            <Button onClick={handleEditPaymentSubmit} disabled={editPaymentSaving}>
              {editPaymentSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showApplyCreditModal} onOpenChange={setShowApplyCreditModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply Credit Memo</DialogTitle>
            <DialogDescription>
              Invoice balance: {invoice ? formatCurrency(parseFloat(invoice.balance)) : '—'}.
              {totalAvailableCredit > 0
                ? ` Available credit: ${formatCurrency(totalAvailableCredit)}.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Credit memo</Label>
              {availableCredits.length ? (
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {availableCredits.map((cm) => {
                    const selected = applyCreditId === cm.id
                    const applyAmt = invoice
                      ? Math.min(cm.remainingCredit, parseFloat(invoice.balance || '0'))
                      : cm.remainingCredit
                    return (
                      <button
                        key={cm.id}
                        type="button"
                        onClick={() => selectCreditForApply(cm.id)}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                          selected
                            ? 'border-primary bg-primary/5 ring-1 ring-primary'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{cm.creditMemoNumber}</span>
                          <span className="text-green-700 font-semibold">
                            {formatCurrency(cm.remainingCredit)} left
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Can apply {formatCurrency(applyAmt)} to this invoice
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No open credit memos for this client.{' '}
                  <Link
                    href={`/dashboard/credit-memos/new?invoiceId=${invoiceId}`}
                    className="text-primary hover:underline"
                  >
                    Create one
                  </Link>
                  .
                </p>
              )}
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label>Amount</Label>
                {applyCreditId && invoice && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => {
                      const cm = availableCredits.find((c) => c.id === applyCreditId)
                      if (!cm) return
                      setApplyCreditAmount(
                        String(Math.min(cm.remainingCredit, parseFloat(invoice.balance || '0')))
                      )
                    }}
                  >
                    Use max
                  </button>
                )}
              </div>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                value={applyCreditAmount}
                onChange={(e) => setApplyCreditAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowApplyCreditModal(false)}
              disabled={applyCreditBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => submitApplyCredit()}
              disabled={applyCreditBusy || !applyCreditId}
            >
              {applyCreditBusy
                ? 'Applying...'
                : applyCreditAmount
                  ? `Apply ${formatCurrency(Number(applyCreditAmount) || 0)}`
                  : 'Apply Credit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSendModal} onOpenChange={setShowSendModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Invoice</DialogTitle>
            <DialogDescription>
              Choose which contacts should receive this invoice, or add a custom email below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Recipients</Label>
              <ContactRecipientPicker
                clientId={invoice.client?.id || null}
                onSelectionChange={(emails) => setSelectedRecipientEmails(emails)}
                manageContactsHref={invoice.client ? `/dashboard/clients/${invoice.client.id}/edit` : undefined}
              />
            </div>

            <div className="space-y-2">
              <Label>Additional email(s) (optional)</Label>
              <Input
                value={customEmails}
                onChange={(e) => setCustomEmails(e.target.value)}
                placeholder="someone-else@email.com"
              />
              <p className="text-xs text-muted-foreground">Multiple emails: separate with commas.</p>
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
              onClick={() => submitSendInvoice()}
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

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          {activeTab === 'customer' ? (
            <Card>
              <CardHeader>
                <CardTitle>Customer invoice</CardTitle>
                <CardDescription>
                  Bundled Line # view. Download, email, and payment links use this by default.
                  Edit from the Edit page Customer tab.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CustomerEstimatePanel customerLines={customerLines} readOnly entityLabel="invoice" />
              </CardContent>
            </Card>
          ) : null}

          {/* Line Items */}
          {activeTab === 'company' ? (
          <Card>
            <CardHeader>
              <CardTitle>Company invoice</CardTitle>
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
                      <th className="text-right py-2 px-4 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Group line items by groupId
                      const groupedItems = new Map<string, typeof invoice.lineItems>()
                      const ungroupedItems: typeof invoice.lineItems = []

                      for (const item of invoice.lineItems) {
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
                        const isExpanded = expandedGroups.has(groupId)

                        rows.push(
                          <tr key={`group-${groupId}`} className="border-b bg-gray-50">
                            <td className="py-3 px-4">
                              <div className="flex items-center justify-between">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newExpanded = new Set(expandedGroups)
                                    if (isExpanded) {
                                      newExpanded.delete(groupId)
                                    } else {
                                      newExpanded.add(groupId)
                                    }
                                    setExpandedGroups(newExpanded)
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
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(groupTotal)}
                            </td>
                          </tr>
                        )

                        if (isExpanded) {
                          items.forEach((item) => {
                            rows.push(
                              <tr key={item.id} className="border-b bg-gray-50/50">
                                <td className="py-3 px-4 pl-8 whitespace-pre-wrap break-words">{item.description}</td>
                                <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                                <td className="py-3 px-4 text-right">{item.quantity}</td>
                                <td className="py-3 px-4 text-right">{formatCurrency(parseFloat(item.unitPrice))}</td>
                                <td className="py-3 px-4 text-right">
                                  {formatCurrency(parseFloat(item.total))}
                                </td>
                              </tr>
                            )
                          })
                          // Add "Add Item" row
                          rows.push(
                            <tr key={`add-item-${groupId}`} className="border-b bg-gray-50/50">
                              <td colSpan={5} className="py-2 px-4 pl-8">
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

                      // Render ungrouped items
                      ungroupedItems.forEach((item) => {
                        if (item.isSubtotal) {
                          rows.push(
                            <tr key={item.id} className="border-b bg-slate-50">
                              <td colSpan={4} className="py-2 px-4 text-right text-sm font-semibold text-slate-700">
                                Subtotal
                              </td>
                              <td className="py-2 px-4 text-right font-bold text-slate-800">
                                {formatCurrency(parseFloat(item.total || '0'))}
                              </td>
                            </tr>
                          )
                          return
                        }
                        rows.push(
                          <tr key={item.id} className="border-b">
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.description}</td>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                            <td className="py-3 px-4 text-right">{item.quantity}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(parseFloat(item.unitPrice))}</td>
                            <td className="py-3 px-4 text-right font-semibold">
                              {formatCurrency(parseFloat(item.total))}
                            </td>
                          </tr>
                        )
                      })

                      // Optional add-on items are appended inline into the main items table
                      optionalItems.forEach((item: any) => {
                        const isVisibleToClient = item.isVisibleToClient ?? true
                        rows.push(
                          <tr key={`opt-${item.id}`} className={`border-b ${!isVisibleToClient ? 'bg-gray-50' : ''}`}>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">
                              {item.description}
                              <span className="ml-1 text-xs rounded bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-blue-700">add-on</span>
                              {!isVisibleToClient && (
                                <span className="ml-2 text-xs text-gray-500">(Hidden from client)</span>
                              )}
                            </td>
                            <td className="py-3 px-4 whitespace-pre-wrap break-words">{item.notes || '-'}</td>
                            <td className="py-3 px-4 text-right">{item.quantity}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(parseFloat(item.unitPrice || '0'))}</td>
                            <td className="py-3 px-4 text-right font-semibold">{formatCurrency(parseFloat(item.total || '0'))}</td>
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
          ) : null}

          {/* Payments */}
          {invoice.payments && invoice.payments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Payments</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {invoice.payments.map((payment) => (
                    <div key={payment.id} className="group flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div>
                        <div className="font-semibold">{formatCurrency(parseFloat(payment.amount))}</div>
                        <div className="text-sm text-gray-600">
                          {payment.method}{' \u2022 '}{payment.status}
                          {payment.processedAt && ` \u2022 ${formatDate(payment.processedAt)}`}
                        </div>
                        {payment.reference && (
                          <div className="text-xs text-gray-500">Ref: {payment.reference}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {payment.status === 'COMPLETED' && (
                          <CheckCircle className="h-5 w-5 text-green-600" />
                        )}
                        <button
                          onClick={() => openEditPayment(payment)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-800"
                          title="Edit payment"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeletePayment(payment)}
                          disabled={deletingPaymentId === payment.id}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-50 text-gray-500 hover:text-red-700 disabled:opacity-50"
                          title="Delete payment"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Notes & Terms */}
          {(invoice.notes || invoice.terms || invoice.memo) && (
            <div className="grid gap-6 md:grid-cols-2">
              {invoice.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle>Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-700 whitespace-pre-wrap">{invoice.notes}</p>
                  </CardContent>
                </Card>
              )}
              {invoice.terms && (
                <Card>
                  <CardHeader>
                    <CardTitle>Terms & Conditions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-700 whitespace-pre-wrap">{invoice.terms}</p>
                  </CardContent>
                </Card>
              )}
              {invoice.memo && (
                <Card className="md:col-span-2">
                  <CardHeader>
                    <CardTitle>Memo</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-700 whitespace-pre-wrap">{invoice.memo}</p>
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
              {invoice.estimateId && (
                <div className="flex items-center justify-between rounded border p-2">
                  <span className="text-sm font-medium">Bill the Rest</span>
                  <Checkbox checked={billRest} onCheckedChange={(checked) => setBillRest(Boolean(checked))} />
                </div>
              )}
              {invoice.estimateId && invoice.progressBillingMode === 'PERCENTAGE' && Number(invoice.progressBillingPercent || 0) > 0 && (
                <div className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-800">
                  Converted from estimate at {Number(invoice.progressBillingPercent).toFixed(0)}%
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Subtotal:</span>
                <span className="font-semibold">{formatCurrency(parseFloat(invoice.subtotal) + optionalItemsSubtotal)}</span>
              </div>
              {parseFloat(invoice.discount) > 0 && (
                <div className="flex justify-between text-red-600">
                  <span>Discount:</span>
                  <span>-{formatCurrency(parseFloat(invoice.discount))}</span>
                </div>
              )}
              {parseFloat(invoice.taxRate) > 0 && (
                <div className="flex justify-between text-gray-600">
                  <span>Tax ({parseFloat(invoice.taxRate) * 100}%):</span>
                  <span>{formatCurrency(parseFloat(invoice.taxAmount))}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold border-t pt-3">
                <span>Total:</span>
                <span>{formatCurrency(parseFloat(invoice.total) + optionalItemsSubtotal)}</span>
              </div>
              {parseFloat(invoice.paidAmount) > 0 && (
                <div className="flex justify-between text-green-600 border-t pt-3">
                  <span>Paid:</span>
                  <span>{formatCurrency(parseFloat(invoice.paidAmount))}</span>
                </div>
              )}
              <div className={`flex justify-between text-lg font-bold border-t pt-3 ${parseFloat(invoice.balance) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                <span>Balance:</span>
                <span>{formatCurrency(parseFloat(invoice.balance))}</span>
              </div>
              {parseFloat(invoice.balance) > 0 && (creditsLoading || totalAvailableCredit > 0) && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-emerald-900">Available credit</span>
                    <span className="font-semibold text-emerald-800">
                      {creditsLoading && !totalAvailableCredit
                        ? '…'
                        : formatCurrency(totalAvailableCredit)}
                    </span>
                  </div>
                  {availableCredits.length === 1 && quickApplyAmount > 0 ? (
                    <Button
                      className="w-full"
                      size="sm"
                      disabled={applyCreditBusy}
                      onClick={() =>
                        submitApplyCredit({
                          creditId: quickApplyCredit.id,
                          amount: quickApplyAmount,
                        })
                      }
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      {applyCreditBusy
                        ? 'Applying...'
                        : `Apply ${formatCurrency(quickApplyAmount)} from ${quickApplyCredit.creditMemoNumber}`}
                    </Button>
                  ) : availableCredits.length > 1 ? (
                    <div className="space-y-1.5">
                      {availableCredits.slice(0, 3).map((cm) => {
                        const amt = Math.min(cm.remainingCredit, parseFloat(invoice.balance))
                        return (
                          <Button
                            key={cm.id}
                            className="w-full justify-between"
                            size="sm"
                            variant="outline"
                            disabled={applyCreditBusy}
                            onClick={() =>
                              submitApplyCredit({ creditId: cm.id, amount: amt })
                            }
                          >
                            <span>{cm.creditMemoNumber}</span>
                            <span>Apply {formatCurrency(amt)}</span>
                          </Button>
                        )
                      })}
                      {availableCredits.length > 3 && (
                        <Button
                          className="w-full"
                          size="sm"
                          variant="ghost"
                          onClick={() => openApplyCreditModal()}
                        >
                          Choose another…
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
              {invoice.estimateId && (
                <Button className="w-full" variant="outline" onClick={handleBillRestLink} disabled={creatingPaymentLink}>
                  <CreditCard className="mr-2 h-4 w-4" />
                  {creatingPaymentLink
                    ? 'Updating...'
                    : billRest
                      ? 'Update Link for Remaining Balance'
                      : 'Use Current Invoice Balance'}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* QuickBooks ACH */}
          <Card>
            <CardHeader>
              <CardTitle>QuickBooks ACH</CardTitle>
              <CardDescription>Hosted ACH payments via QuickBooks Payments</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {qboAchError && (
                <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
                  {qboAchError}
                </div>
              )}

              <div className="text-xs text-gray-500">
                Status: {qboAchIntentStatus || '—'}
              </div>

              <Button
                className="w-full"
                variant="outline"
                onClick={handleCreateQboAchLink}
                disabled={qboAchLoading || parseFloat(invoice.balance) <= 0}
              >
                {qboAchLoading ? 'Working...' : 'Generate ACH payment link'}
              </Button>

              {qboAchPublicUrl && (
                <div className="space-y-2">
                  <div className="text-xs text-gray-500">Customer link</div>
                  <div className="flex gap-2">
                    <Input value={qboAchPublicUrl} readOnly />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard?.writeText(qboAchPublicUrl)
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              )}

              {qboAchHostedUrl && (
                <Button
                  className="w-full"
                  onClick={() => window.open(qboAchHostedUrl, '_blank', 'noopener,noreferrer')}
                  disabled={!qboAchHostedUrl}
                >
                  Open QuickBooks hosted payment
                </Button>
              )}

              <div className="text-xs text-gray-500">
                Requires QuickBooks Payments + invoice synced to QuickBooks.
              </div>
            </CardContent>
          </Card>

          {/* Client Information */}
          {invoice.client && (
            <Card>
              <CardHeader>
                <CardTitle>Client</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Link href={`/dashboard/clients/${invoice.client.id}`} className="text-primary hover:underline">
                    <Building2 className="inline h-4 w-4 mr-2" />
                    {invoice.client.name}
                  </Link>
                  {invoice.client.companyName && (
                    <p className="text-sm text-gray-600 mt-1">{invoice.client.companyName}</p>
                  )}
                </div>
                {primaryContact && (
                  <div className="text-sm text-gray-600">
                    <User className="inline h-4 w-4 mr-2" />
                    {primaryContact.firstName} {primaryContact.lastName}
                    {primaryContact.email && (
                      <p className="mt-1">
                        <FileText className="inline h-3 w-3 mr-1" />
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

          {/* Job Site Address - displayed prominently below Client */}
          {invoice.jobSiteAddress && (
            <Card>
              <CardHeader>
                <CardTitle>Job Site Address</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 whitespace-pre-line">{invoice.jobSiteAddress}</p>
                <iframe
                  title="Invoice Job Site Map"
                  className="mt-3 h-48 w-full rounded-md border"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://maps.google.com/maps?q=${encodeURIComponent(invoice.jobSiteAddress)}&output=embed`}
                />
              </CardContent>
            </Card>
          )}

          {/* Job Information */}
          {invoice.job && (
            <Card>
              <CardHeader>
                <CardTitle>Job</CardTitle>
              </CardHeader>
              <CardContent>
                <Link href={`/dashboard/jobs/${invoice.job.id}`} className="text-primary hover:underline">
                  {invoice.job.jobNumber} - {invoice.job.title}
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
                <span className="text-gray-600">Invoice Date:</span>
                <span>{formatDate(invoice.invoiceDate)}</span>
              </div>
              {invoice.dueDate && (
                <div className={`flex justify-between ${isOverdue ? 'text-red-600 font-semibold' : ''}`}>
                  <span className="text-gray-600">Due Date:</span>
                  <span>{formatDate(invoice.dueDate)}</span>
                </div>
              )}
              {invoice.sentAt && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Sent:</span>
                  <span>{formatDate(invoice.sentAt)}</span>
                </div>
              )}
              {invoice.paidAt && (
                <div className="flex justify-between text-green-600">
                  <span>Paid:</span>
                  <span>{formatDate(invoice.paidAt)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Created:</span>
                <span>{formatDate(invoice.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Last Updated:</span>
                <span>{formatDate(invoice.updatedAt)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentAttachments entityType="invoice" entityId={invoiceId} />
            </CardContent>
          </Card>
        </div>
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
    </ResponsivePage>
  )
}
