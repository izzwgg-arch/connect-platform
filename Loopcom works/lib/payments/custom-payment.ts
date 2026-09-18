/** Fields used to classify manual/custom vs gateway-processed payments. */
export type CustomPaymentLike = {
  method: string
  status: string
  provider?: string | null
  reference?: string | null
  solaTransactionId?: string | null
  providerPaymentId?: string | null
  notes?: string | null
}

const GATEWAY_PROVIDERS = new Set([
  'quickbooks',
  'qbo',
  'qbo_ach',
  'sola',
  'stripe',
  'paypal',
  'cardknox',
])

export type CustomPaymentUiMethod = 'CHECK' | 'QUICK_PAY' | 'OTHER'

/** Gateway/card/ACH/reconcile payments must not be edited as custom payments. */
export function isGatewayPayment(payment: CustomPaymentLike): boolean {
  const provider = String(payment.provider || '').trim().toLowerCase()
  const method = String(payment.method || '').trim().toUpperCase()

  if (payment.solaTransactionId) return true
  if (method === 'CARD' || method === 'ACH') return true
  if (GATEWAY_PROVIDERS.has(provider)) return true

  const reference = String(payment.reference || '')
  if (reference.startsWith('qbo_reconcile_')) return true

  // SOLA / gateway rows often store the gateway id separately.
  if (provider === 'sola' && payment.providerPaymentId) return true

  return false
}

/** Manual/custom payments — includes legacy rows with non-standard provider slugs. */
export function isCustomPayment(payment: CustomPaymentLike): boolean {
  return String(payment.status || '').toUpperCase() === 'COMPLETED' && !isGatewayPayment(payment)
}

export function getCustomPaymentUiMethod(payment: CustomPaymentLike): CustomPaymentUiMethod {
  const method = String(payment.method || '').trim().toUpperCase()
  const provider = String(payment.provider || '').trim().toLowerCase()

  if (method === 'CHECK') return 'CHECK'
  if (method === 'CASH' || provider === 'quick_pay') return 'QUICK_PAY'
  return 'OTHER'
}

/** Payment type name for OTHER/custom legacy rows (notes first, then provider slug). */
export function getCustomPaymentLabel(payment: CustomPaymentLike): string {
  const fromNotes = String(payment.notes || '')
    .replace(/^manually marked as paid\s*[—-]\s*/i, '')
    .replace(/^manually marked as paid by\s+/i, '')
    .trim()
  if (fromNotes) return fromNotes

  const provider = String(payment.provider || '').trim().toLowerCase()
  if (!provider || provider === 'manual' || provider === 'quick_pay' || provider === 'check') {
    return ''
  }

  return provider
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function buildCustomPaymentNotes(
  method: CustomPaymentUiMethod,
  methodLabel?: string
): string {
  if (method === 'CHECK') return 'Manually marked as paid by check'
  if (method === 'QUICK_PAY') return 'Manually marked as paid by Quick Pay'
  if (methodLabel) return `Manually marked as paid — ${methodLabel}`
  return 'Manually marked as paid'
}

export function mapCustomPaymentMethodToDb(
  method: CustomPaymentUiMethod,
  methodLabel?: string
): { method: 'CHECK' | 'CASH' | 'OTHER'; provider: string } {
  if (method === 'CHECK') {
    return { method: 'CHECK', provider: 'manual' }
  }
  if (method === 'QUICK_PAY') {
    return { method: 'CASH', provider: 'quick_pay' }
  }
  const slug = String(methodLabel || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  return {
    method: slug === 'cash' ? 'CASH' : 'OTHER',
    provider: slug || 'manual',
  }
}
