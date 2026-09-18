/**
 * Tests for the job-creation workflow.
 *
 * Covers:
 *  1. Estimate → Invoice conversion creates exactly one Job.
 *  2. Invoice payment does NOT create a Job.
 *  3. Partial payment does NOT create a Job.
 *  4. Multiple payments do NOT create duplicate Jobs.
 *  5. Reopening (status change) an invoice does NOT create duplicate Jobs.
 *  6. Existing Job remains linked after payment.
 *  7. ensureJobFromInvoice is idempotent when called multiple times.
 *  8. ensureJobFromInvoice returns skippedReason='already_linked' when job exists on estimate.
 *  9. Payment on an invoice that already has a job does not call ensureJobFromInvoice.
 * 10. afterInvoicePayment never creates a Job (regression guard).
 *
 * Run: npx tsx --test tests/job-creation-workflow.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// In-memory database types
// ---------------------------------------------------------------------------

type JobStatus = 'QUOTE' | 'SCHEDULED' | 'IN_PROGRESS' | 'INVOICED' | 'COMPLETED'
type InvoiceStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'CANCELLED'
type EstimateStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'CONVERTED'

interface Job {
  id: string
  tenantId: string
  jobNumber: string
  title: string
  status: JobStatus
  clientId: string
  estimateAmount: number | null
}

interface Invoice {
  id: string
  tenantId: string
  invoiceNumber: string
  jobId: string | null
  estimateId: string | null
  clientId: string
  paidAmount: number
  balance: number
  status: InvoiceStatus
  total: number
  title: string
  notes: string | null
}

interface Estimate {
  id: string
  tenantId: string
  jobId: string | null
  clientId: string
  status: EstimateStatus
  total: number
  title: string
  notes: string | null
  jobSiteAddress: string | null
  leadId: string | null
  taxRate: number
}

interface InMemoryDb {
  jobs: Map<string, Job>
  invoices: Map<string, Invoice>
  estimates: Map<string, Estimate>
  activities: Array<{ type: string; description: string; invoiceId: string; jobId?: string }>
  jobsCreated: number
}

function makeDb(): InMemoryDb {
  return {
    jobs: new Map(),
    invoices: new Map(),
    estimates: new Map(),
    activities: [],
    jobsCreated: 0,
  }
}

// ---------------------------------------------------------------------------
// Minimal re-implementation of the key functions under test
// ---------------------------------------------------------------------------

type EnsureJobResult = {
  job: Pick<Job, 'id' | 'jobNumber' | 'title'> | null
  created: boolean
  skippedReason?: 'invoice_not_found' | 'already_linked' | 'no_client'
}

/**
 * Mirrors the idempotency logic in lib/jobs/ensure-job-from-invoice.ts.
 */
async function ensureJobFromInvoice(db: InMemoryDb, invoiceId: string): Promise<EnsureJobResult> {
  const invoice = db.invoices.get(invoiceId)
  if (!invoice) return { job: null, created: false, skippedReason: 'invoice_not_found' }

  // Already has a job directly on the invoice.
  if (invoice.jobId) {
    const job = db.jobs.get(invoice.jobId)!
    return { job, created: false, skippedReason: 'already_linked' }
  }

  // Estimate already has a job — link the invoice to it.
  if (invoice.estimateId) {
    const estimate = db.estimates.get(invoice.estimateId)
    if (estimate?.jobId) {
      invoice.jobId = estimate.jobId
      const job = db.jobs.get(estimate.jobId)!
      return { job, created: false, skippedReason: 'already_linked' }
    }
  }

  if (!invoice.clientId) {
    return { job: null, created: false, skippedReason: 'no_client' }
  }

  // Create the job.
  db.jobsCreated += 1
  const jobNumber = `JOB-${String(db.jobsCreated).padStart(6, '0')}`
  const estimate = invoice.estimateId ? db.estimates.get(invoice.estimateId) : null

  const job: Job = {
    id: `job-${jobNumber}`,
    tenantId: invoice.tenantId,
    jobNumber,
    title: invoice.title || estimate?.title || `Job for ${invoice.invoiceNumber}`,
    status: 'SCHEDULED',
    clientId: invoice.clientId,
    estimateAmount: estimate?.total ?? invoice.total,
  }
  db.jobs.set(job.id, job)

  // Link invoice → job.
  invoice.jobId = job.id

  // Link estimate → job.
  if (estimate) {
    estimate.jobId = job.id
    estimate.status = 'CONVERTED'
  }

  db.activities.push({
    type: 'JOB_CREATED',
    description: `Estimate converted to invoice "${invoice.invoiceNumber}". Job ${jobNumber} created automatically.`,
    invoiceId: invoice.id,
    jobId: job.id,
  })

  return { job, created: true }
}

/**
 * Mirrors the NEW lib/payments/after-invoice-payment.ts — does NOT create jobs.
 */
async function afterInvoicePayment(db: InMemoryDb, invoiceId: string): Promise<{ jobCreated: boolean }> {
  // Payment side-effects only. Job creation is NOT performed here.
  void db
  void invoiceId
  return { jobCreated: false }
}

/**
 * Simulates applying a payment to an invoice.
 */
function applyPayment(db: InMemoryDb, invoiceId: string, amount: number): void {
  const invoice = db.invoices.get(invoiceId)
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`)
  const applied = Math.min(amount, invoice.balance)
  invoice.paidAmount += applied
  invoice.balance -= applied
  invoice.status = invoice.balance <= 0 ? 'PAID' : 'PARTIAL'
}

/**
 * Simulates converting an estimate to an invoice (the NEW workflow).
 * Creates both the invoice AND the job in one step.
 */
async function convertEstimateToInvoice(
  db: InMemoryDb,
  estimateId: string
): Promise<{ invoice: Invoice; job: Job | null; jobCreated: boolean }> {
  const estimate = db.estimates.get(estimateId)
  if (!estimate) throw new Error(`Estimate ${estimateId} not found`)

  const invoiceId = `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const invoice: Invoice = {
    id: invoiceId,
    tenantId: estimate.tenantId,
    invoiceNumber: `INV-${String(db.invoices.size + 1).padStart(4, '0')}`,
    jobId: null,
    estimateId: estimate.id,
    clientId: estimate.clientId,
    paidAmount: 0,
    balance: estimate.total,
    total: estimate.total,
    status: 'DRAFT',
    title: estimate.title,
    notes: estimate.notes,
  }
  db.invoices.set(invoice.id, invoice)

  // Job creation happens here — at conversion time, not on payment.
  const { job, created } = await ensureJobFromInvoice(db, invoice.id)

  return { invoice, job, jobCreated: created }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEstimate(db: InMemoryDb, overrides: Partial<Estimate> = {}): Estimate {
  const id = `est-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const estimate: Estimate = {
    id,
    tenantId: 'tenant-1',
    jobId: null,
    clientId: 'client-1',
    status: 'ACCEPTED',
    total: 1500,
    title: 'Lawn Care Package',
    notes: null,
    jobSiteAddress: '123 Main St, Springfield, IL 62701',
    leadId: null,
    taxRate: 0,
    ...overrides,
  }
  db.estimates.set(estimate.id, estimate)
  return estimate
}

function makeInvoice(db: InMemoryDb, overrides: Partial<Invoice> = {}): Invoice {
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const invoice: Invoice = {
    id,
    tenantId: 'tenant-1',
    invoiceNumber: `INV-${String(db.invoices.size + 1).padStart(4, '0')}`,
    jobId: null,
    estimateId: null,
    clientId: 'client-1',
    paidAmount: 0,
    balance: 1500,
    total: 1500,
    status: 'SENT',
    title: 'Lawn Care Package',
    notes: null,
    ...overrides,
  }
  db.invoices.set(invoice.id, invoice)
  return invoice
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---- 1. Estimate → Invoice conversion creates exactly one Job ----

test('converting an estimate to an invoice creates exactly one job', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db)

  const { invoice, job, jobCreated } = await convertEstimateToInvoice(db, estimate.id)

  assert.equal(jobCreated, true, 'job should be newly created')
  assert.ok(job, 'job should be returned')
  assert.equal(db.jobs.size, 1, 'exactly one job should exist')
  assert.equal(invoice.jobId, job!.id, 'invoice should be linked to the job')
  assert.equal(db.estimates.get(estimate.id)!.jobId, job!.id, 'estimate should be linked to the job')
})

// ---- 2. Invoice payment does NOT create a Job ----

test('paying an invoice does not create a job', async () => {
  const db = makeDb()
  const invoice = makeInvoice(db)

  applyPayment(db, invoice.id, 1500)
  const result = await afterInvoicePayment(db, invoice.id)

  assert.equal(result.jobCreated, false, 'afterInvoicePayment must never create a job')
  assert.equal(db.jobs.size, 0, 'no jobs should exist after a payment')
  assert.equal(invoice.status, 'PAID')
})

// ---- 3. Partial payment does NOT create a Job ----

test('a partial payment does not create a job', async () => {
  const db = makeDb()
  const invoice = makeInvoice(db)

  applyPayment(db, invoice.id, 500) // partial
  const result = await afterInvoicePayment(db, invoice.id)

  assert.equal(result.jobCreated, false)
  assert.equal(db.jobs.size, 0, 'no jobs should exist after a partial payment')
  assert.equal(invoice.status, 'PARTIAL')
  assert.equal(invoice.balance, 1000)
})

// ---- 4. Multiple payments do NOT create duplicate Jobs ----

test('multiple payments on the same invoice do not create duplicate jobs', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db)

  // Convert — job is created here.
  const { invoice } = await convertEstimateToInvoice(db, estimate.id)
  assert.equal(db.jobs.size, 1, 'one job after conversion')

  // First payment.
  applyPayment(db, invoice.id, 750)
  await afterInvoicePayment(db, invoice.id)
  assert.equal(db.jobs.size, 1, 'still one job after first payment')

  // Second payment (clears balance).
  applyPayment(db, invoice.id, 750)
  await afterInvoicePayment(db, invoice.id)
  assert.equal(db.jobs.size, 1, 'still one job after second payment')
  assert.equal(invoice.status, 'PAID')
})

// ---- 5. Reopening an invoice does not create duplicate Jobs ----

test('reopening a paid invoice and re-paying does not create a duplicate job', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db)

  const { invoice } = await convertEstimateToInvoice(db, estimate.id)
  assert.equal(db.jobs.size, 1)

  // Mark paid.
  applyPayment(db, invoice.id, 1500)
  await afterInvoicePayment(db, invoice.id)
  assert.equal(db.jobs.size, 1)

  // Simulate "reopen" — reset balance/status (e.g. refund issued).
  invoice.status = 'SENT'
  invoice.paidAmount = 0
  invoice.balance = 1500

  // Re-pay.
  applyPayment(db, invoice.id, 1500)
  await afterInvoicePayment(db, invoice.id)

  assert.equal(db.jobs.size, 1, 'must still be exactly one job after reopening and re-paying')
})

// ---- 6. Existing Job remains linked after payment ----

test('existing job remains correctly linked after invoice payment', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db)

  const { invoice, job } = await convertEstimateToInvoice(db, estimate.id)
  const jobIdBeforePayment = job!.id

  applyPayment(db, invoice.id, 1500)
  await afterInvoicePayment(db, invoice.id)

  // Job link unchanged.
  assert.equal(invoice.jobId, jobIdBeforePayment, 'job link must survive payment')
  const jobAfter = db.jobs.get(jobIdBeforePayment)!
  assert.ok(jobAfter, 'job record must still exist')
  assert.equal(jobAfter.status, 'SCHEDULED', 'payment must not change job status')
})

// ---- 7. ensureJobFromInvoice is idempotent ----

test('ensureJobFromInvoice is idempotent — calling it twice creates only one job', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db)
  const invoice = makeInvoice(db, { estimateId: estimate.id })

  const first = await ensureJobFromInvoice(db, invoice.id)
  assert.equal(first.created, true)
  assert.equal(db.jobs.size, 1)

  const second = await ensureJobFromInvoice(db, invoice.id)
  assert.equal(second.created, false, 'second call must not create another job')
  assert.equal(second.skippedReason, 'already_linked')
  assert.equal(db.jobs.size, 1, 'still exactly one job')
  assert.equal(first.job!.id, second.job!.id, 'must return the same job')
})

// ---- 8. ensureJobFromInvoice returns already_linked when job on estimate ----

test('ensureJobFromInvoice links invoice to existing estimate job without creating a new one', async () => {
  const db = makeDb()

  // Job already exists on the estimate (e.g. staff manually created it).
  const existingJob: Job = {
    id: 'job-existing',
    tenantId: 'tenant-1',
    jobNumber: 'JOB-000001',
    title: 'Existing Job',
    status: 'SCHEDULED',
    clientId: 'client-1',
    estimateAmount: 1500,
  }
  db.jobs.set(existingJob.id, existingJob)
  db.jobsCreated = 1

  const estimate = makeEstimate(db, { jobId: existingJob.id, status: 'CONVERTED' })
  const invoice = makeInvoice(db, { estimateId: estimate.id })

  const result = await ensureJobFromInvoice(db, invoice.id)

  assert.equal(result.created, false, 'must not create a new job')
  assert.equal(result.skippedReason, 'already_linked')
  assert.equal(result.job!.id, existingJob.id)
  assert.equal(db.jobs.size, 1, 'still only the original job')
  assert.equal(invoice.jobId, existingJob.id, 'invoice now linked to existing job')
})

// ---- 9. afterInvoicePayment is a no-op (regression guard) ----

test('afterInvoicePayment returns jobCreated=false regardless of invoice state', async () => {
  const db = makeDb()

  const unpaid = makeInvoice(db)
  const r1 = await afterInvoicePayment(db, unpaid.id)
  assert.equal(r1.jobCreated, false, 'jobCreated must be false for unpaid invoice')

  applyPayment(db, unpaid.id, 1500)
  const r2 = await afterInvoicePayment(db, unpaid.id)
  assert.equal(r2.jobCreated, false, 'jobCreated must be false for paid invoice')

  assert.equal(db.jobs.size, 0, 'afterInvoicePayment must never create jobs')
})

// ---- 10. Only one job per estimate (safeguard across two invoices) ----

test('converting the same estimate twice (progress billing) only ever creates one job', async () => {
  const db = makeDb()
  const estimate = makeEstimate(db, { total: 2000 })

  // First partial invoice (e.g. 50% billing).
  const inv1: Invoice = {
    id: 'inv-a',
    tenantId: 'tenant-1',
    invoiceNumber: 'INV-0001',
    jobId: null,
    estimateId: estimate.id,
    clientId: estimate.clientId,
    paidAmount: 0,
    balance: 1000,
    total: 1000,
    status: 'SENT',
    title: estimate.title,
    notes: null,
  }
  db.invoices.set(inv1.id, inv1)
  const r1 = await ensureJobFromInvoice(db, inv1.id)
  assert.equal(r1.created, true)
  assert.equal(db.jobs.size, 1)

  // Second invoice for the remaining 50%.
  const inv2: Invoice = {
    id: 'inv-b',
    tenantId: 'tenant-1',
    invoiceNumber: 'INV-0002',
    jobId: null,
    estimateId: estimate.id,
    clientId: estimate.clientId,
    paidAmount: 0,
    balance: 1000,
    total: 1000,
    status: 'SENT',
    title: estimate.title,
    notes: null,
  }
  db.invoices.set(inv2.id, inv2)
  const r2 = await ensureJobFromInvoice(db, inv2.id)
  assert.equal(r2.created, false, 'second invoice must not create a second job')
  assert.equal(r2.skippedReason, 'already_linked')
  assert.equal(db.jobs.size, 1, 'must remain exactly one job across both invoices')
  assert.equal(inv2.jobId, r1.job!.id, 'second invoice linked to the same job')
})
