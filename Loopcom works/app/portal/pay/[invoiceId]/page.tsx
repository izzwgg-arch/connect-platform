'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Script from 'next/script'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { parsePublicPaymentAmount } from '@/lib/payments/bulk-card-allocation'
import { isDevEnvironment } from '@/lib/dev'

const SOLA_PAYMENT_INTENT_KEY = 'sola_payment_intent_ref'

interface PublicInvoice {
  id: string
  invoiceNumber: string
  title: string
  status: string
  subtotal: string
  taxAmount: string
  total: string
  balance: string
  invoiceDate: string
  dueDate: string | null
  client: {
    name: string
    companyName: string | null
  }
  outstanding?: {
    count: number
    total: number
    invoices: Array<{
      id: string
      invoiceNumber: string
      balance: string
      invoiceDate: string
      dueDate: string | null
      isCurrent: boolean
    }>
  }
  lineItems: Array<{
    id: string
    description: string
    notes?: string
    quantity: string
    unitPrice: string
    total: string
    isSubtotal?: boolean
  }>
}

function toCurrency(value: string | number) {
  const n = typeof value === 'number' ? value : Number(value || 0)
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function PublicPaymentPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const invoiceId = params.invoiceId as string
  const token = searchParams.get('token') || ''
  const gatewayResult = searchParams.get('xResult') || searchParams.get('Result') || ''
  const gatewayStatus = searchParams.get('status') || searchParams.get('xStatus') || ''
  const gatewayRef =
    searchParams.get('xRefnum') ||
    searchParams.get('xRefNum') ||
    searchParams.get('transactionId') ||
    searchParams.get('transaction_id') ||
    ''
  const gatewayInvoice = searchParams.get('xInvoice') || searchParams.get('invoiceId') || ''
  const gatewayAmount = searchParams.get('xAmount') || searchParams.get('amount') || ''
  const gatewayCustom =
    searchParams.get('xCustom1') || searchParams.get('xCustom') || searchParams.get('Custom1') || ''

  const [invoice, setInvoice] = useState<PublicInvoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState(false)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
  const [showOutstanding, setShowOutstanding] = useState(false)
  const [showLineItems, setShowLineItems] = useState(false)
  const [previewInvoiceId, setPreviewInvoiceId] = useState<string | null>(null)
  const [previewInvoice, setPreviewInvoice] = useState<PublicInvoice | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewSelectedLineItemIds, setPreviewSelectedLineItemIds] = useState<string[]>([])
  const [partialSelection, setPartialSelection] = useState<{
    invoiceId: string
    invoiceNumber: string
    lineItemIds: string[]
    amount: number
  } | null>(null)
  const [customPrevAmount, setCustomPrevAmount] = useState<string>('')
  const [customPrevEnabled, setCustomPrevEnabled] = useState(false)
  const [invoicePayAmounts, setInvoicePayAmounts] = useState<Record<string, string>>({})
  const [customApplyBusy, setCustomApplyBusy] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [reconcilingPayment, setReconcilingPayment] = useState(false)
  const [achProcessing, setAchProcessing] = useState(false)
  const [remainingAchLinks, setRemainingAchLinks] = useState<Array<{ invoiceId: string; invoiceNumber?: string; hostedUrl: string }>>([])

  const [recaptchaSiteKey, setRecaptchaSiteKey] = useState<string>(
    process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || ''
  )
  const [recaptchaScriptLoaded, setRecaptchaScriptLoaded] = useState(false)

  useEffect(() => {
    const body = document.body
    const prev = body.getAttribute('data-allow-scroll')
    body.setAttribute('data-allow-scroll', 'true')
    return () => {
      if (prev == null) body.removeAttribute('data-allow-scroll')
      else body.setAttribute('data-allow-scroll', prev)
    }
  }, [])

  useEffect(() => {
    if (recaptchaSiteKey) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/public/recaptcha/site-key')
        const data = await res.json().catch(() => ({}))
        const key = String(data?.siteKey || '')
        if (!cancelled && key) setRecaptchaSiteKey(key)
      } catch {
        // ignore
      }
    })()
    return () => { cancelled = true }
  }, [recaptchaSiteKey])

  const getRecaptchaToken = async (action: string): Promise<string> => {
    if (isDevEnvironment() && !recaptchaSiteKey) return 'dev-bypass'
    if (!recaptchaSiteKey) throw new Error('reCAPTCHA is not configured')
    const grecaptcha = (window as any).grecaptcha
    if (!grecaptcha) throw new Error('reCAPTCHA script not loaded. Please refresh the page.')
    await new Promise<void>((resolve, reject) => {
      if (grecaptcha.ready) {
        grecaptcha.ready(() => resolve())
      } else {
        const timeout = setTimeout(() => reject(new Error('reCAPTCHA timeout')), 5000)
        const checkReady = () => {
          if (grecaptcha.ready) { clearTimeout(timeout); grecaptcha.ready(() => resolve()) }
          else setTimeout(checkReady, 100)
        }
        checkReady()
      }
    })
    const t = await grecaptcha.execute(recaptchaSiteKey, { action })
    if (!t) throw new Error('Failed to generate reCAPTCHA token')
    return String(t)
  }
  const captchaReady =
    (isDevEnvironment() && !recaptchaSiteKey) ||
    Boolean(recaptchaSiteKey && recaptchaScriptLoaded)
  const reconciledReturnRef = useRef(false)

  useEffect(() => {
    if (searchParams.get('invoices') === '1') {
      setShowOutstanding(true)
    }
  }, [searchParams])

  // Warm up reCAPTCHA after the script loads so the pay action gets a better score.
  useEffect(() => {
    if (!captchaReady) return
    const grecaptcha = (window as any).grecaptcha
    if (!grecaptcha?.execute) return
    grecaptcha.ready(() => {
      grecaptcha.execute(recaptchaSiteKey, { action: 'public_invoice_pay_pageview' }).catch(() => {})
    })
  }, [captchaReady, recaptchaSiteKey])

  const parsedCustomAmount = useMemo(
    () => parsePublicPaymentAmount(customPrevAmount),
    [customPrevAmount]
  )

  useEffect(() => {
    const fetchInvoice = async () => {
      if (!token) { setError('Missing payment token.'); setLoading(false); return }
      try {
        const response = await fetch(`/api/public/invoices/${invoiceId}?token=${encodeURIComponent(token)}`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) { setError(data.error || 'Unable to load invoice.'); return }
        setInvoice(data.invoice)
        const open = Array.isArray(data?.invoice?.outstanding?.invoices) ? data.invoice.outstanding.invoices : []
        const currentId = String(data?.invoice?.id || invoiceId)
        const currentIsOpen = open.some((x: any) => String(x?.id) === currentId)
        setSelectedInvoiceIds(currentIsOpen ? [currentId] : open.length ? [String(open[0].id)] : [currentId])
      } catch {
        setError('Unable to load invoice.')
      } finally {
        setLoading(false)
      }
    }
    fetchInvoice()
    const stored = sessionStorage.getItem('qbo_ach_remaining')
    if (stored) {
      try {
        const links = JSON.parse(stored)
        if (Array.isArray(links) && links.length > 0) setRemainingAchLinks(links)
      } catch { /* ignore */ }
    }
  }, [invoiceId, token])

  useEffect(() => {
    const loadPreview = async () => {
      if (!previewInvoiceId) { setPreviewInvoice(null); return }
      if (!token) return
      setPreviewLoading(true)
      try {
        const res = await fetch(`/api/public/invoices/preview?token=${encodeURIComponent(token)}&id=${encodeURIComponent(previewInvoiceId)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setError(data.error || 'Unable to load invoice preview.'); setPreviewInvoice(null); return }
        setPreviewInvoice(data.invoice || null)
      } catch {
        setError('Unable to load invoice preview.'); setPreviewInvoice(null)
      } finally {
        setPreviewLoading(false)
      }
    }
    loadPreview()
  }, [previewInvoiceId, token])

  useEffect(() => {
    if (!previewInvoice) return
    setPreviewSelectedLineItemIds((prev) => (prev.length ? prev : (previewInvoice.lineItems || []).filter((li) => !li.isSubtotal).map((li) => li.id)))
  }, [previewInvoice])

  useEffect(() => {
    if (!partialSelection) return
    if (selectedInvoiceIds.length !== 1 || selectedInvoiceIds[0] !== partialSelection.invoiceId) setPartialSelection(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInvoiceIds])

  useEffect(() => {
    if (!customPrevEnabled) return
    setPartialSelection(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPrevEnabled])

  const refreshInvoice = async () => {
    if (!token) return
    try {
      const response = await fetch(`/api/public/invoices/${invoiceId}?token=${encodeURIComponent(token)}`)
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.invoice) setInvoice(data.invoice)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    const normalizedResult = String(gatewayResult || '').toUpperCase()
    const normalizedStatus = String(gatewayStatus || '').toLowerCase()
    const looksFailed = ['D','DECLINED','ERROR','FAILED','CANCELLED'].includes(normalizedResult) ||
      ['failed','declined','canceled','cancelled','error'].includes(normalizedStatus)
    const hasGatewayProof = Boolean(gatewayResult || gatewayStatus || gatewayRef || gatewayAmount)
    const shouldReconcile = Boolean(token && hasGatewayProof && !looksFailed)
    if (!shouldReconcile || reconcilingPayment || reconciledReturnRef.current) return
    const reconcileFromReturn = async () => {
      try {
        setReconcilingPayment(true)
        reconciledReturnRef.current = true
        const body = new URLSearchParams()
        if (gatewayResult) body.set('xResult', gatewayResult)
        if (gatewayRef) body.set('xRefnum', gatewayRef)
        if (gatewayInvoice) body.set('xInvoice', gatewayInvoice)
        if (gatewayAmount) body.set('xAmount', gatewayAmount)
        if (gatewayStatus) body.set('status', gatewayStatus)
        if (!gatewayResult && (gatewayRef || gatewayStatus)) body.set('status', 'approved')
        body.set('invoiceId', gatewayInvoice || invoiceId)
        body.set('xInvoice', gatewayInvoice || invoiceId)
        const storedIntentRef = sessionStorage.getItem(SOLA_PAYMENT_INTENT_KEY) || gatewayCustom
        if (storedIntentRef) body.set('xCustom1', storedIntentRef)
        await fetch('/api/webhooks/sola-payment', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        sessionStorage.removeItem(SOLA_PAYMENT_INTENT_KEY)
        const response = await fetch(`/api/public/invoices/${invoiceId}?token=${encodeURIComponent(token)}`)
        const data = await response.json().catch(() => ({}))
        if (response.ok && data.invoice) { setInvoice(data.invoice); setConfirmation('Payment received. Invoice status was updated.') }
      } catch { /* ignore */ } finally { setReconcilingPayment(false) }
    }
    reconcileFromReturn()
  }, [token, invoiceId, gatewayResult, gatewayRef, gatewayInvoice, gatewayAmount, gatewayStatus, gatewayCustom, reconcilingPayment])

  const isPaid = useMemo(() => Number(invoice?.balance || 0) <= 0, [invoice?.balance])
  const outstandingCount = Number(invoice?.outstanding?.count || 0)
  const outstandingTotal = Number(invoice?.outstanding?.total || 0)
  const openInvoices = Array.isArray(invoice?.outstanding?.invoices) ? invoice!.outstanding!.invoices : []
  const previousInvoices = openInvoices.filter((i) => !i.isCurrent)
  // Nothing left to pay: this invoice is settled and there's no other open
  // balance for this client either. Swaps the pay UI for a paid confirmation.
  const nothingToPay = isPaid && outstandingCount === 0

  // A paid invoice has no payment action pulling focus, so open the line
  // items straight away instead of leaving them behind a collapsed accordion.
  useEffect(() => {
    if (isPaid) setShowLineItems(true)
  }, [isPaid])
  const parsedPerInvoiceAmounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const id of selectedInvoiceIds) {
      const amount = parsePublicPaymentAmount(invoicePayAmounts[id])
      if (amount != null) out[id] = amount
    }
    return out
  }, [selectedInvoiceIds, invoicePayAmounts])
  const hasPerInvoiceAmounts = Object.keys(parsedPerInvoiceAmounts).length > 0

  const selectedTotal = useMemo(() => {
    if (partialSelection && selectedInvoiceIds.length === 1 && selectedInvoiceIds[0] === partialSelection.invoiceId)
      return Number(partialSelection.amount || 0)
    if (customPrevEnabled && parsedCustomAmount != null) {
      return parsedCustomAmount
    }
    if (hasPerInvoiceAmounts) {
      const byId = new Map(openInvoices.map((i) => [String(i.id), Number(i.balance || 0)]))
      return selectedInvoiceIds.reduce((sum, id) => {
        const custom = parsedPerInvoiceAmounts[id]
        if (custom == null) return sum
        return sum + Math.min(custom, Number(byId.get(String(id)) || 0))
      }, 0)
    }
    const byId = new Map(openInvoices.map((i) => [String(i.id), Number(i.balance || 0)]))
    return selectedInvoiceIds.reduce((sum, id) => sum + Math.max(0, Number(byId.get(String(id)) || 0)), 0)
  }, [openInvoices, selectedInvoiceIds, partialSelection, customPrevEnabled, parsedCustomAmount, hasPerInvoiceAmounts, parsedPerInvoiceAmounts])
  const selectAllChecked = openInvoices.length > 0 && selectedInvoiceIds.length === openInvoices.length
  const selectAllIndeterminate = selectedInvoiceIds.length > 0 && selectedInvoiceIds.length < openInvoices.length

  const handlePayNow = async () => {
    if (!invoice || !approved || processing) return
    if (selectedInvoiceIds.length === 0 && !customPrevEnabled) { setError('Select at least one invoice to pay.'); return }
    if (customPrevEnabled && parsedCustomAmount == null && !hasPerInvoiceAmounts) {
      setError('Enter a valid custom amount and click Apply.')
      return
    }
    if (hasPerInvoiceAmounts && !customPrevEnabled && selectedTotal <= 0) {
      setError('Enter a valid payment amount for at least one selected invoice.')
      return
    }
    setProcessing(true)
    setError(null)
    try {
      const payload: any = { token, selectedInvoiceIds }
      if (customPrevEnabled && parsedCustomAmount != null) {
        payload.customPrevOnly = true
        payload.customPrevAmount = parsedCustomAmount
      }
      if (hasPerInvoiceAmounts) {
        payload.plannedAmountsByInvoice = parsedPerInvoiceAmounts
      }
      if (partialSelection && selectedInvoiceIds.length === 1 && selectedInvoiceIds[0] === partialSelection.invoiceId && partialSelection.lineItemIds.length > 0) {
        payload.partialInvoiceId = partialSelection.invoiceId
        payload.partialLineItemIds = partialSelection.lineItemIds
      }

      const postPaymentLink = async (recaptchaToken: string) => {
        return fetch(`/api/public/invoices/${invoice.id}/payment-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, recaptchaToken }),
        })
      }

      let recaptchaToken = await getRecaptchaToken('public_invoice_pay_card')
      let response = await postPaymentLink(recaptchaToken)
      let data = await response.json().catch(() => ({}))

      if (!response.ok && data.error === 'reCAPTCHA score too low') {
        await new Promise((resolve) => setTimeout(resolve, 800))
        recaptchaToken = await getRecaptchaToken('public_invoice_pay_card')
        response = await postPaymentLink(recaptchaToken)
        data = await response.json().catch(() => ({}))
      }

      if (!response.ok || !data.paymentUrl) { setError(data.error || 'Unable to create payment link.'); return }
      if (data.reference) sessionStorage.setItem(SOLA_PAYMENT_INTENT_KEY, String(data.reference))
      window.location.href = data.paymentUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to redirect to payment.')
    } finally { setProcessing(false) }
  }

  const handlePayByAch = async () => {
    if (!invoice || !approved || achProcessing) return
    if (partialSelection) { setError('Partial payments are currently available for card payments only.'); return }
    if (customPrevEnabled) { setError('Custom amount toward previous invoices is currently available for card payments only.'); return }
    if (selectedInvoiceIds.length === 0) { setError('Please select at least one invoice to pay.'); return }
    setAchProcessing(true); setError(null)
    try {
      const achLinks: Array<{ invoiceId: string; invoiceNumber?: string; hostedUrl: string }> = []
      for (const targetInvoiceId of selectedInvoiceIds) {
        const recaptchaToken = await getRecaptchaToken('public_invoice_pay_ach')
        const response = await fetch(`/api/public/invoices/${invoice.id}/qbo-ach-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, recaptchaToken, targetInvoiceId, returnUrl: window.location.href }) })
        const data = await response.json().catch(() => ({}))
        if (response.ok && data?.hostedUrl) {
          const outstanding = invoice.outstanding?.invoices || []
          const inv = outstanding.find((i: any) => String(i.id) === String(targetInvoiceId))
          achLinks.push({ invoiceId: targetInvoiceId, invoiceNumber: inv?.invoiceNumber || targetInvoiceId, hostedUrl: data.hostedUrl })
        } else { setError(data.error || `Unable to create ACH link for invoice ${targetInvoiceId}`); return }
      }
      if (achLinks.length === 0) { setError('No ACH payment links were created.'); return }
      if (achLinks.length > 1) {
        const remaining = achLinks.slice(1)
        sessionStorage.setItem('qbo_ach_remaining', JSON.stringify(remaining))
        sessionStorage.setItem('qbo_ach_return_url', window.location.href)
        sessionStorage.setItem('qbo_ach_total_count', String(achLinks.length))
        sessionStorage.setItem('qbo_ach_current_index', '1')
        const invoiceNumbers = achLinks.map(l => l.invoiceNumber || l.invoiceId).join(', ')
        if (!confirm(`You selected ${achLinks.length} invoice(s) to pay by ACH:\n${invoiceNumbers}\n\nQuickBooks requires each invoice to be paid separately. You will be redirected to pay the first invoice, then you can continue with the remaining ${remaining.length} invoice(s).\n\nClick OK to proceed.`)) { setAchProcessing(false); return }
      }
      window.location.href = achLinks[0].hostedUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to redirect to ACH payment.')
    } finally { setAchProcessing(false) }
  }

  const achDisabled = !approved || achProcessing || !captchaReady || selectedInvoiceIds.length === 0
  const cardDisabled =
    !approved ||
    processing ||
    !captchaReady ||
    (customPrevEnabled && parsedCustomAmount == null && !hasPerInvoiceAmounts) ||
    (!customPrevEnabled && !hasPerInvoiceAmounts && selectedInvoiceIds.length === 0 && !partialSelection) ||
    (hasPerInvoiceAmounts && !customPrevEnabled && selectedTotal <= 0)

  // ── Loading / error / paid states ──────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600" />
          <p className="text-sm text-slate-500">Loading invoice...</p>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mb-2 text-2xl">!</div>
          <p className="text-sm text-red-600">{error || 'Invoice not found.'}</p>
        </div>
      </div>
    )
  }

  // When the current invoice is already paid, there's nothing left to collect
  // on it specifically — but the customer clicked "View Invoice" wanting to
  // actually see it (line items, total, a PDF), not a bare confirmation. So we
  // fall through to the main render below rather than short-circuiting: the
  // "paid" state below adjusts the hero/payment card, and if this client has
  // OTHER open invoices, they can still pay those from the same page.

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50">
      {/* reCAPTCHA */}
      {recaptchaSiteKey ? (
        <Script
          src={`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(recaptchaSiteKey)}`}
          strategy="afterInteractive"
          onLoad={() => setRecaptchaScriptLoaded(true)}
          onError={() => setError('Failed to load security check. Please refresh the page.')}
        />
      ) : null}

      {/* Invoice preview modal */}
      {previewInvoiceId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
          <div className="w-full max-w-lg rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div className="text-sm font-semibold text-slate-900">
                Invoice{previewInvoice?.invoiceNumber ? ` ${previewInvoice.invoiceNumber}` : ' Preview'}
              </div>
              <button
                onClick={() => setPreviewInvoiceId(null)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                X
              </button>
            </div>
            <div className="max-h-[75vh] overflow-y-auto p-5">
              {previewLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500" />
                  Loading...
                </div>
              ) : !previewInvoice ? (
                <p className="text-sm text-slate-500">No preview available.</p>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold text-slate-900">
                        {previewInvoice.title || `Invoice ${previewInvoice.invoiceNumber}`}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {previewInvoice.client?.name} -{' '}
                        {previewInvoice.invoiceDate ? new Date(previewInvoice.invoiceDate).toLocaleDateString() : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-slate-500">Balance</div>
                      <div className="text-lg font-bold text-slate-900">{toCurrency(previewInvoice.balance)}</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {(previewInvoice.lineItems || []).map((li) => {
                      const checked = previewSelectedLineItemIds.includes(li.id)
                      if (li.isSubtotal) {
                        return (
                          <div key={li.id} className="flex items-start justify-between rounded-xl border border-slate-200 bg-slate-50 p-3 font-semibold">
                            <div className="text-sm text-slate-900">Subtotal</div>
                            <div className="text-sm text-slate-900">{toCurrency(li.total)}</div>
                          </div>
                        )
                      }
                      return (
                        <div key={li.id} className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${checked ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}>
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              const next = Boolean(v)
                              setPreviewSelectedLineItemIds((prev) =>
                                next ? Array.from(new Set([...prev, li.id])) : prev.filter((x) => x !== li.id)
                              )
                            }}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-900 whitespace-pre-wrap break-words">{li.description}</div>
                            <div className="mt-0.5 text-xs text-slate-500">
                              Qty {li.quantity} x {toCurrency(li.unitPrice)}
                            </div>
                          </div>
                          <div className="text-sm font-semibold text-slate-900">{toCurrency(li.total)}</div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="rounded-xl bg-slate-50 p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between text-slate-600">
                      <span>Subtotal</span><span>{toCurrency(previewInvoice.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>Tax</span><span>{toCurrency(previewInvoice.taxAmount)}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-slate-900">
                      <span>Balance Due</span><span>{toCurrency(previewInvoice.balance)}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="text-xs text-slate-500">
                      {previewSelectedLineItemIds.length} item(s) selected -{' '}
                      <span className="font-semibold text-slate-700">
                        {toCurrency(
                          (previewInvoice.lineItems || [])
                            .filter((li) => !li.isSubtotal && previewSelectedLineItemIds.includes(li.id))
                            .reduce((sum, li) => sum + Math.max(0, Number(li.total || 0)), 0)
                        )}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => window.open(`/api/public/invoices/${previewInvoice.id}/pdf?download=1&token=${encodeURIComponent(token)}`, '_blank')}
                        className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Download PDF
                      </button>
                      <button
                        onClick={() => {
                          if (!previewInvoice?.id) return
                          const amount = (previewInvoice.lineItems || [])
                            .filter((li) => !li.isSubtotal && previewSelectedLineItemIds.includes(li.id))
                            .reduce((sum, li) => sum + Math.max(0, Number(li.total || 0)), 0)
                          if (!Number.isFinite(amount) || amount <= 0) { setError('Select at least one item to pay.'); return }
                          setSelectedInvoiceIds([previewInvoice.id])
                          setPartialSelection({ invoiceId: previewInvoice.id, invoiceNumber: previewInvoice.invoiceNumber, lineItemIds: previewSelectedLineItemIds, amount })
                          setPreviewInvoiceId(null)
                        }}
                        className="flex-1 rounded-xl bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                      >
                        Pay selected items
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-lg px-4 pb-16 pt-6">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Payment Portal</p>
          <h1 className="mt-1 text-xl font-bold text-slate-900">{invoice.title || `Invoice ${invoice.invoiceNumber}`}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-slate-500">
            <span>{invoice.client.companyName || invoice.client.name}</span>
            <span className="text-slate-300">-</span>
            <span>{invoice.invoiceNumber}</span>
            <span className="text-slate-300">-</span>
            <span>{new Date(invoice.invoiceDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          </div>
          {isPaid && (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              Paid in full - Thank you!
            </div>
          )}
        </div>

        {/* ── Status messages ─────────────────────────────────────────── */}
        {confirmation && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
            <span>OK</span> {confirmation}
          </div>
        )}
        {reconcilingPayment && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
            Confirming payment status...
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* ── ACH continuation banner ─────────────────────────────────── */}
        {remainingAchLinks.length > 0 && (
          <div className="mb-4 rounded-2xl bg-blue-50 p-4">
            <div className="text-sm font-semibold text-blue-900">Continue ACH Payment</div>
            <p className="mt-1 text-sm text-blue-700">
              {remainingAchLinks.length} more invoice{remainingAchLinks.length > 1 ? 's' : ''} to pay:{' '}
              <span className="font-medium">{remainingAchLinks.map(l => l.invoiceNumber || l.invoiceId).join(', ')}</span>
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  const next = remainingAchLinks[0]
                  const remaining = remainingAchLinks.slice(1)
                  if (remaining.length > 0) sessionStorage.setItem('qbo_ach_remaining', JSON.stringify(remaining))
                  else { sessionStorage.removeItem('qbo_ach_remaining'); sessionStorage.removeItem('qbo_ach_return_url'); sessionStorage.removeItem('qbo_ach_total_count'); sessionStorage.removeItem('qbo_ach_current_index') }
                  setRemainingAchLinks(remaining)
                  window.location.href = next.hostedUrl
                }}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Pay {remainingAchLinks[0]?.invoiceNumber || 'Next Invoice'}
              </button>
              <button
                onClick={() => { sessionStorage.removeItem('qbo_ach_remaining'); sessionStorage.removeItem('qbo_ach_return_url'); sessionStorage.removeItem('qbo_ach_total_count'); sessionStorage.removeItem('qbo_ach_current_index'); setRemainingAchLinks([]) }}
                className="rounded-xl border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* ── Partial / custom selection banners ──────────────────────── */}
        {partialSelection && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm">
            <span className="text-amber-900">
              Partial payment: <span className="font-semibold">{toCurrency(partialSelection.amount)}</span> for {partialSelection.invoiceNumber}
            </span>
            <button onClick={() => setPartialSelection(null)} className="text-xs text-amber-700 underline">Clear</button>
          </div>
        )}
        {customPrevEnabled && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm">
            <span className="text-amber-900">
              Custom total: <span className="font-semibold">{toCurrency(selectedTotal)}</span>
            </span>
            <button onClick={() => { setCustomPrevEnabled(false); setCustomPrevAmount('') }} className="text-xs text-amber-700 underline">Clear</button>
          </div>
        )}

        {/* ── HERO: Paid in Full / Balance Due ─────────────────────────── */}
        {nothingToPay ? (
          <div className="mb-4 rounded-2xl px-6 py-6 text-center bg-emerald-700">
            <p className="text-xs font-semibold uppercase tracking-widest text-emerald-200">Total Paid</p>
            <p className="mt-2 text-5xl font-extrabold tracking-tight text-white">
              {toCurrency(invoice.total)}
            </p>
            <p className="mt-2 text-xs text-emerald-200">
              Invoice {invoice.invoiceNumber} - fully paid, no balance due.
            </p>
          </div>
        ) : (
        <div className="mb-4 rounded-2xl px-6 py-6 text-center" style={{ background: '#243f53' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#8cb4cf' }}>Balance Due</p>
          <p className="mt-2 text-5xl font-extrabold tracking-tight text-white">
            {toCurrency(selectedTotal || invoice.balance)}
          </p>
          {selectedInvoiceIds.length > 1 && (
            <p className="mt-1 text-sm" style={{ color: '#8cb4cf' }}>{selectedInvoiceIds.length} invoices selected</p>
          )}
          {invoice.dueDate && (
            <p className="mt-2 text-xs" style={{ color: '#6b9ab8' }}>
              Due {new Date(invoice.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </div>
        )}

        {/* ── Approval checkbox + payment actions ───────────────────────
            Nothing to collect: skip straight to the invoice details below. */}
        {!nothingToPay && (
        <>
        <div
          className={`mb-4 flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 transition-colors ${
            approved ? 'border-slate-200 bg-white' : 'border-slate-200 bg-white'
          }`}
          style={approved ? { borderColor: '#243f53', backgroundColor: 'rgba(36,63,83,0.06)' } : undefined}
          onClick={() => setApproved((a) => !a)}
        >
          <Checkbox
            id="approve-invoice"
            checked={approved}
            onCheckedChange={(checked) => setApproved(Boolean(checked))}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 shrink-0"
          />
          <label htmlFor="approve-invoice" className="cursor-pointer text-sm leading-snug text-slate-700">
            {selectedInvoiceIds.length > 1
              ? 'I approve these invoices and authorize payment.'
              : 'I approve this invoice and authorize payment.'}
          </label>
        </div>

        {/* ── Payment actions ──────────────────────────────────────────── */}
        <div className="mb-6 rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-2 text-sm font-semibold text-slate-900">How would you like to pay?</p>
          <p className="mb-3 text-xs text-slate-500">
            Amount to pay:{' '}
            <span className="font-semibold text-slate-700">{toCurrency(selectedTotal || invoice.balance)}</span>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              disabled={achDisabled}
              onClick={handlePayByAch}
              title="Pay by ACH via QuickBooks (one invoice at a time)"
              className="rounded-xl py-3 text-sm font-bold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #1e4d6e 0%, #c9a84c 100%)', color: '#ffffff' }}
            >
              {achProcessing
                ? 'Creating payment links...'
                : selectedInvoiceIds.length > 1
                  ? `Pay ${selectedInvoiceIds.length} Invoices by ACH`
                  : 'Pay by ACH'}
            </button>
            <button
              disabled={cardDisabled}
              onClick={handlePayNow}
              className="rounded-xl py-3 text-sm font-bold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #1e4d6e 0%, #c9a84c 100%)', color: '#ffffff' }}
            >
              {processing
                ? 'Redirecting...'
                : customPrevEnabled
                  ? 'Pay Custom Amount by Card'
                  : selectedInvoiceIds.length > 1
                    ? 'Pay Selected by Card'
                    : 'Pay by Card'}
            </button>
          </div>
          {!recaptchaSiteKey ? (
            isDevEnvironment() ? (
              <p className="mt-2 text-xs text-amber-600">
                Development mode: security check bypassed so you can test Pay by Card locally.
              </p>
            ) : (
              <p className="mt-2 text-xs text-red-600">
                Payment security check is not configured. Please contact support.
              </p>
            )
          ) : !recaptchaScriptLoaded ? (
            <p className="mt-2 text-xs text-slate-500">Loading security check...</p>
          ) : null}
          <p className="mt-2 text-xs text-slate-500">
            Card payments are processed via our card processor. ACH payments open a QuickBooks-hosted payment page.
            After payment completes, this page updates once the receipt is received.
          </p>
        </div>
        </>
        )}

        {/* ── Open invoices accordion ─────────────────────────────────── */}
        {invoice?.outstanding && outstandingCount > 0 && (
          <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm">
            <button
              onClick={() => setShowOutstanding((s) => !s)}
              className="flex w-full items-center justify-between px-5 py-4 text-left"
            >
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {outstandingCount} open invoice{outstandingCount === 1 ? '' : 's'}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Total outstanding: <span className="font-semibold text-slate-700">{toCurrency(outstandingTotal)}</span>
                </p>
              </div>
              <span className="text-slate-400">{showOutstanding ? '^' : 'v'}</span>
            </button>

            {showOutstanding && (
              <div className="border-t border-slate-100 px-4 pb-4 pt-3 space-y-3">
                {/* Custom previous amount */}
                {previousInvoices.length > 0 && (
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs font-semibold text-slate-700">Pay a custom total</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Applies to selected invoices only. Pays the current invoice first, then works down the list. Any invoice not fully covered is marked partial in Trim Pro and QuickBooks.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={customPrevAmount}
                        onChange={(e) => setCustomPrevAmount(e.target.value)}
                        placeholder="Total amount (e.g. 2500)"
                        className="h-9 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                        inputMode="decimal"
                      />
                      <button
                        disabled={!approved || customApplyBusy}
                        onClick={async () => {
                          const amount = parsePublicPaymentAmount(customPrevAmount)
                          if (amount == null) { setError('Enter a valid amount greater than 0.'); return }
                          setCustomApplyBusy(true)
                          setError(null)
                          try {
                            setCustomPrevAmount(String(amount))
                            setCustomPrevEnabled(true)
                            setPartialSelection(null)
                            setInvoicePayAmounts({})
                          } finally {
                            setCustomApplyBusy(false)
                          }
                        }}
                        className="rounded-xl bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                      >
                        {customApplyBusy ? 'Applying...' : 'Apply'}
                      </button>
                    </div>
                    {!approved && <p className="mt-1 text-xs text-slate-400">Check the approval box above to enable.</p>}
                  </div>
                )}

                {/* Select all */}
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-slate-600">Select invoices to pay</p>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                    <Checkbox
                      id="select-all"
                      checked={selectAllChecked}
                      onCheckedChange={(checked) => {
                        const next = Boolean(checked)
                        setSelectedInvoiceIds(next ? openInvoices.map((i) => String(i.id)) : [])
                        setCustomPrevEnabled(false)
                        if (!next) setInvoicePayAmounts({})
                      }}
                      disabled={customPrevEnabled}
                    />
                    Select all{selectAllIndeterminate ? ' (partial)' : ''}
                  </label>
                </div>

                {/* Invoice rows */}
                <p className="text-xs text-slate-500">
                  Optional: enter a custom amount on any invoice. Leave blank to use the full balance, or use Pay a custom total above to pay down from the current invoice first.
                </p>
                <div className="space-y-1.5">
                  {openInvoices.map((inv) => {
                    const id = String(inv.id)
                    const checked = selectedInvoiceIds.includes(id)
                    const balance = Number(inv.balance || 0)
                    const customAmount = parsePublicPaymentAmount(invoicePayAmounts[id])
                    return (
                      <div
                        key={id}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                          checked && !customPrevEnabled ? 'border-slate-900 bg-slate-900/5' : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            const next = Boolean(v)
                            setCustomPrevEnabled(false)
                            setSelectedInvoiceIds((prev) => next ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id))
                            if (!next) {
                              setInvoicePayAmounts((prev) => {
                                const copy = { ...prev }
                                delete copy[id]
                                return copy
                              })
                            }
                          }}
                          className="shrink-0"
                        />
                        <button
                          type="button"
                          className="flex-1 min-w-0 text-left"
                          onClick={() => setPreviewInvoiceId(id)}
                        >
                          <p className="text-sm font-medium text-slate-900 truncate">
                            {inv.invoiceNumber}{inv.isCurrent ? ' - Current' : ''}
                          </p>
                          <p className="text-xs text-slate-400">Tap to preview</p>
                        </button>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <p className="text-sm font-semibold text-slate-900">{toCurrency(inv.balance)}</p>
                          {checked && !customPrevEnabled && (
                            <div className="relative" onClick={(e) => e.stopPropagation()}>
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                              <input
                                value={invoicePayAmounts[id] || ''}
                                onChange={(e) => {
                                  setCustomPrevEnabled(false)
                                  setInvoicePayAmounts((prev) => ({ ...prev, [id]: e.target.value }))
                                }}
                                placeholder={balance.toFixed(2)}
                                className="h-8 w-28 rounded-lg border border-slate-200 bg-white pl-5 pr-2 text-right text-xs"
                                inputMode="decimal"
                                aria-label={`Custom payment amount for ${inv.invoiceNumber}`}
                              />
                            </div>
                          )}
                          {checked && customAmount != null && customAmount < balance && (
                            <p className="text-[10px] font-medium text-amber-700">Partial</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Selected: <span className="font-semibold">{selectedInvoiceIds.length}</span> invoice(s) -{' '}
                  Total: <span className="font-semibold">{toCurrency(selectedTotal)}</span>
                  {customPrevEnabled && parsedCustomAmount != null && (
                    <span className="block mt-1 text-slate-500">
                      Custom total {toCurrency(parsedCustomAmount)} will pay the current invoice first, then continue down the list.
                    </span>
                  )}
                  {hasPerInvoiceAmounts && !customPrevEnabled && (
                    <span className="block mt-1 text-slate-500">
                      Custom amounts apply only to invoices where you entered a value.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Line items (mobile accordion) ───────────────────────────── */}
        <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm">
          <button
            onClick={() => setShowLineItems((s) => !s)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
          >
            <div>
              <p className="text-sm font-semibold text-slate-900">Invoice details</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {invoice.lineItems.length} item{invoice.lineItems.length === 1 ? '' : 's'} - Total {toCurrency(invoice.total)}
              </p>
            </div>
            <span className="text-slate-400">{showLineItems ? '^' : 'v'}</span>
          </button>

          {showLineItems && (
            <div className="border-t border-slate-100 px-4 pb-4 pt-3 space-y-2">
              <div className="md:hidden space-y-2">
              {invoice.lineItems.map((li) => (
                <div key={li.id} className={`rounded-xl px-3 py-2.5 ${li.isSubtotal ? 'bg-slate-100' : 'bg-slate-50'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900 leading-snug whitespace-pre-wrap break-words">{li.isSubtotal ? 'Subtotal' : li.description}</p>
                    <p className="shrink-0 text-sm font-bold text-slate-900">{toCurrency(li.total)}</p>
                  </div>
                  {!li.isSubtotal && (
                    <p className="mt-0.5 text-xs text-slate-500">Qty {li.quantity} x {toCurrency(li.unitPrice)}</p>
                  )}
                  {!li.isSubtotal && li.notes && (
                    <p className="mt-1 text-xs text-slate-500 italic whitespace-pre-wrap break-words">{li.notes}</p>
                  )}
                </div>
              ))}
              </div>
              <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Unit</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lineItems.map((li) => (
                      li.isSubtotal ? (
                        <tr key={li.id} className="border-b last:border-b-0 bg-slate-50 font-semibold">
                          <td colSpan={3} className="px-3 py-2 text-right">Subtotal</td>
                          <td className="px-3 py-2 text-right">{toCurrency(li.total)}</td>
                        </tr>
                      ) : (
                        <tr key={li.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2">
                            <div className="whitespace-pre-wrap break-words">{li.description}</div>
                            {li.notes && (
                              <div className="text-xs text-slate-500 italic mt-0.5 whitespace-pre-wrap break-words">{li.notes}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">{li.quantity}</td>
                          <td className="px-3 py-2 text-right">{toCurrency(li.unitPrice)}</td>
                          <td className="px-3 py-2 text-right">{toCurrency(li.total)}</td>
                        </tr>
                      )
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-xl bg-slate-100 px-3 py-2.5 space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span><span>{toCurrency(invoice.subtotal)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Tax</span><span>{toCurrency(invoice.taxAmount)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-300 pt-2 font-bold text-slate-900">
                  <span>Balance Due</span><span>{toCurrency(invoice.balance)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Secondary actions ───────────────────────────────────────── */}
        <div className="flex gap-2">
          <button
            onClick={() => window.open(`/api/public/invoices/${invoice.id}/pdf?download=1&token=${encodeURIComponent(token)}`, '_blank')}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50"
          >
            Download PDF
          </button>
          <button
            onClick={refreshInvoice}
            disabled={loading}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {/* ── Footer note ─────────────────────────────────────────────── */}
        <p className="mt-8 text-center text-xs text-slate-400">
          Secured by reCAPTCHA - All payments encrypted
        </p>

      </div>
    </div>
  )
}
