/** QuickBooks PaymentRefNum / doc_num max length */
export const QBO_PAYMENT_REF_NUM_MAX = 21

/** Extract the gateway transaction id from stored payment fields. */
export function extractGatewayTransactionId(raw: unknown): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  // Bulk sola ids look like "<txnId>:<invoiceId>"
  const beforeColon = value.includes(':') ? value.split(':')[0]?.trim() || value : value
  // Bulk references look like "<txnId> - Invoice INV-000123"
  const beforeDash = beforeColon.split(' - ')[0]?.trim() || beforeColon
  return beforeDash.replace(/\s+/g, '')
}

/**
 * Build a QBO-safe PaymentRefNum (max 21 chars).
 * Keeps bulk payments from the same card txn distinguishable per invoice when possible.
 */
export function buildQboPaymentRefNum(params: {
  transactionId?: unknown
  solaTransactionId?: unknown
  providerPaymentId?: unknown
  reference?: unknown
  invoiceNumber?: unknown
  paymentId?: unknown
}): string | null {
  const txn =
    extractGatewayTransactionId(params.providerPaymentId) ||
    extractGatewayTransactionId(params.transactionId) ||
    extractGatewayTransactionId(params.solaTransactionId) ||
    extractGatewayTransactionId(params.reference)

  if (txn) {
    const invSuffix = String(params.invoiceNumber || '')
      .replace(/^INV-/i, '')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(-6)
    if (invSuffix) {
      const combined = `${txn}-${invSuffix}`
      if (combined.length <= QBO_PAYMENT_REF_NUM_MAX) return combined
    }
    return txn.slice(0, QBO_PAYMENT_REF_NUM_MAX)
  }

  const fallback = String(params.paymentId || '').replace(/[^A-Za-z0-9]/g, '').slice(-QBO_PAYMENT_REF_NUM_MAX)
  return fallback || null
}
