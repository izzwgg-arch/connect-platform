import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/**
 * applyInvoicePayment — the ONE authoritative way money is applied to an invoice.
 *
 * Every payment path in the app (Sola card webhook, QuickBooks/ACH webhook, ACH
 * reconcile, manual mark-paid, and bulk manual payments) funnels through here so
 * that paid amounts and PAID/PARTIAL status are computed in exactly one place,
 * the same way, every time.
 *
 * Hardening guarantees (these are the properties the rest of the system relies on):
 *
 *  1. Idempotent. A payment is recorded at most once. Callers pass `dedupeWhere`
 *     (e.g. `{ solaTransactionId }`, `{ invoiceId, reference }`, or
 *     `{ provider, providerPaymentId }`). If a matching payment already exists we
 *     return `{ created: false }` with the existing id and a current invoice
 *     snapshot — we never double-apply. Unique DB constraints
 *     (`solaTransactionId`, `[invoiceId, reference]`, `[provider, providerPaymentId]`)
 *     are the final backstop: a P2002 race is treated as "already applied", not an error.
 *
 *  2. Never overpays. The applied amount is clamped to the invoice's remaining
 *     balance. A deposit / partial payment can therefore NEVER flip an invoice to
 *     PAID, and a stray "assume the full balance" value can never push paidAmount
 *     past the total.
 *
 *  3. Authoritative status. Status is derived from the resulting balance only:
 *     balance ~= 0 -> PAID, otherwise any money paid -> PARTIAL. There is no
 *     special-casing that can leave a fully-paid invoice looking unpaid or a
 *     partly-paid invoice looking paid.
 *
 *  4. Concurrency-safe. The invoice row is locked FOR UPDATE inside the
 *     transaction before we read/compute/write, so two confirmations arriving at
 *     the same time (gateway webhook + browser return) cannot lose an update.
 */

export type ApplyInvoicePaymentMethod =
  | 'CARD'
  | 'ACH'
  | 'BANK_TRANSFER'
  | 'CHECK'
  | 'CASH'
  | 'OTHER'
  | 'CREDIT'

export interface ApplyInvoicePaymentInput {
  invoiceId: string
  /** Optional guard — when provided the invoice must belong to this tenant. */
  tenantId?: string | null
  /** Gross amount the customer paid toward THIS invoice. Clamped to remaining. */
  amount: number
  method: ApplyInvoicePaymentMethod
  provider: string
  providerPaymentId?: string | null
  providerInvoiceId?: string | null
  providerRealmId?: string | null
  reference?: string | null
  solaTransactionId?: string | null
  solaWebhookData?: Prisma.InputJsonValue | null
  rawPayload?: Prisma.InputJsonValue | null
  processedAt?: Date | null
  notes?: string | null
  /** Groups sibling payments from one customer transaction across many invoices. */
  paymentGroupId?: string | null
  /** Currency, defaults to USD. */
  currency?: string
  /**
   * Where-clause used to detect an already-recorded payment for this same
   * gateway transaction. When omitted we fall back to provider+providerPaymentId
   * (when present) so we still dedupe by the DB unique constraint.
   */
  dedupeWhere?: Prisma.PaymentWhereInput
}

export interface ApplyInvoicePaymentResult {
  created: boolean
  paymentId: string | null
  invoice: { paidAmount: number; balance: number; status: string } | null
  /** Machine-readable reason when created === false. */
  reason?:
    | 'invoice_not_found'
    | 'invoice_not_payable'
    | 'duplicate'
    | 'no_remaining_balance'
    | 'non_positive_amount'
}

interface ApplyOptions {
  tx?: Prisma.TransactionClient
}

const CENTS = 100
/** Round to whole cents to avoid floating-point drift in money math. */
function round2(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * CENTS) / CENTS
}

/** Half-cent tolerance: treat a balance at/under this as fully paid. */
const PAID_EPSILON = 0.005

type InvoiceStatusValue =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'PARTIAL'
  | 'PAID'
  | 'OVERDUE'
  | 'CANCELLED'
  | 'REFUNDED'

const UNPAYABLE_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'REFUNDED'])

async function runApply(
  tx: Prisma.TransactionClient,
  input: ApplyInvoicePaymentInput
): Promise<ApplyInvoicePaymentResult> {
  // 1) Lock the invoice row so concurrent confirmations serialize on it.
  //    (No-op safe if the invoice does not exist — handled by the read below.)
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${input.invoiceId} FOR UPDATE`

  const invoice = await tx.invoice.findFirst({
    where: {
      id: input.invoiceId,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      total: true,
      paidAmount: true,
      balance: true,
      status: true,
      paidAt: true,
    },
  })

  if (!invoice) {
    return { created: false, paymentId: null, invoice: null, reason: 'invoice_not_found' }
  }

  const snapshot = () => ({
    paidAmount: round2(invoice.paidAmount),
    balance: round2(invoice.balance),
    status: String(invoice.status),
  })

  if (UNPAYABLE_STATUSES.has(String(invoice.status))) {
    return { created: false, paymentId: null, invoice: snapshot(), reason: 'invoice_not_payable' }
  }

  // 2) Idempotency: never record the same gateway transaction twice.
  //    Reference is scoped to the invoice so one check/ref can pay many invoices
  //    in a payment group without the later siblings being treated as duplicates.
  const dedupeWhere =
    input.dedupeWhere ||
    (input.provider && input.providerPaymentId
      ? { provider: input.provider, providerPaymentId: input.providerPaymentId }
      : input.solaTransactionId
        ? { solaTransactionId: input.solaTransactionId }
        : input.reference
          ? { reference: input.reference, invoiceId: invoice.id }
          : null)

  if (dedupeWhere) {
    const existing = await tx.payment.findFirst({
      where: dedupeWhere,
      select: { id: true },
    })
    if (existing) {
      return { created: false, paymentId: existing.id, invoice: snapshot(), reason: 'duplicate' }
    }
  }

  // 3) Clamp the applied amount to what is actually owed. This is the core
  //    protection against deposits/partials being recorded as full payment.
  const total = round2(invoice.total)
  const currentPaid = round2(invoice.paidAmount)
  const remaining = round2(total - currentPaid)

  if (remaining <= 0) {
    return { created: false, paymentId: null, invoice: snapshot(), reason: 'no_remaining_balance' }
  }

  const requested = round2(input.amount)
  if (requested <= 0) {
    return { created: false, paymentId: null, invoice: snapshot(), reason: 'non_positive_amount' }
  }

  const applied = round2(Math.min(requested, remaining))
  if (applied <= 0) {
    return { created: false, paymentId: null, invoice: snapshot(), reason: 'non_positive_amount' }
  }

  // 4) Create the payment row. Unique constraints are the final dedupe backstop.
  let paymentId: string
  try {
    const payment = await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: applied,
        currency: input.currency || 'USD',
        status: 'COMPLETED',
        method: input.method,
        provider: input.provider || null,
        providerPaymentId: input.providerPaymentId ?? null,
        providerInvoiceId: input.providerInvoiceId ?? null,
        providerRealmId: input.providerRealmId ?? null,
        reference: input.reference ?? null,
        solaTransactionId: input.solaTransactionId ?? null,
        solaWebhookData: (input.solaWebhookData ?? undefined) as Prisma.InputJsonValue | undefined,
        rawPayload: (input.rawPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        paymentGroupId: input.paymentGroupId ?? null,
        processedAt: input.processedAt ?? new Date(),
        notes: input.notes ?? null,
      },
      select: { id: true },
    })
    paymentId = payment.id
  } catch (error) {
    // P2002 = unique constraint violation: another delivery beat us to it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = dedupeWhere
        ? await tx.payment.findFirst({ where: dedupeWhere, select: { id: true } })
        : null
      return {
        created: false,
        paymentId: existing?.id ?? null,
        invoice: snapshot(),
        reason: 'duplicate',
      }
    }
    throw error
  }

  // 5) Recompute invoice totals authoritatively and persist.
  const newPaidAmount = round2(currentPaid + applied)
  const newBalance = round2(total - newPaidAmount)
  const fullyPaid = newBalance <= PAID_EPSILON

  const nextStatus: InvoiceStatusValue = fullyPaid
    ? 'PAID'
    : newPaidAmount > 0
      ? 'PARTIAL'
      : (String(invoice.status) as InvoiceStatusValue)

  const updated = await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      paidAmount: newPaidAmount,
      balance: fullyPaid ? 0 : newBalance,
      status: nextStatus,
      paidAt: fullyPaid ? (invoice.paidAt ?? input.processedAt ?? new Date()) : invoice.paidAt,
    },
    select: { paidAmount: true, balance: true, status: true },
  })

  return {
    created: true,
    paymentId,
    invoice: {
      paidAmount: round2(updated.paidAmount),
      balance: round2(updated.balance),
      status: String(updated.status),
    },
  }
}

/**
 * Apply a payment to an invoice. Runs inside the caller's transaction when
 * `opts.tx` is provided (so a multi-invoice group is one atomic unit); otherwise
 * it opens its own transaction.
 */
export async function applyInvoicePayment(
  input: ApplyInvoicePaymentInput,
  opts?: ApplyOptions
): Promise<ApplyInvoicePaymentResult> {
  if (opts?.tx) {
    return runApply(opts.tx, input)
  }
  return prisma.$transaction((tx) => runApply(tx, input))
}

export default applyInvoicePayment
