/**
 * Run lifecycle side-effects after an invoice receives payment.
 *
 * Job creation has intentionally been removed from this function.
 * Jobs are created when an estimate is converted to an invoice, not when the
 * invoice is paid.  This function is retained for future payment-lifecycle
 * hooks (e.g. send receipt, trigger overdue checks) without touching job state.
 */
export async function afterInvoicePayment(_invoiceId: string): Promise<void> {
  // No job-creation side-effects on payment.
  // Receipt emails are sent directly by the individual payment webhooks/routes.
}
