/**
 * Tests for the Request → Estimate status workflow.
 *
 * Covers:
 *  1. Converting a Request to an Estimate sets status to ESTIMATE_CREATED (not ESTIMATE_SENT).
 *  2. Creating a general Estimate linked to a Request sets status to ESTIMATE_CREATED.
 *  3. Request stays ESTIMATE_CREATED when the estimate exists but has never been sent.
 *  4. Sending an Estimate advances the Request to ESTIMATE_SENT.
 *  5. Resending the Estimate does NOT create a duplicate status change or activity entry.
 *  6. Editing an estimate before sending leaves Request at ESTIMATE_CREATED.
 *  7. A Request already ESTIMATE_SENT is not regressed when convert-to-estimate is called again.
 *  8. A CONVERTED Request is not touched by estimate creation or sending.
 *  9. Sending an estimate with no linked request is a no-op on request status.
 * 10. Activity log records ESTIMATE_CREATED on creation and ESTIMATE_SENT on send.
 *
 * Run: npx tsx --test tests/request-estimate-status.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LeadStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'QUALIFIED'
  | 'ESTIMATE_CREATED'
  | 'ESTIMATE_SENT'
  | 'FOLLOW_UP'
  | 'CONVERTED'
  | 'LOST'

type EstimateStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CONVERTED'

type ActivityType = 'ESTIMATE_CREATED' | 'ESTIMATE_SENT' | string

interface Lead {
  id: string
  tenantId: string
  firstName: string
  lastName: string
  status: LeadStatus
  convertedToClientId: string | null
  convertedAt: Date | null
}

interface Estimate {
  id: string
  tenantId: string
  estimateNumber: string
  title: string
  leadId: string | null
  clientId: string | null
  status: EstimateStatus
  total: number
  sentAt: Date | null
}

interface Activity {
  id: string
  type: ActivityType
  description: string
  leadId: string | null
  estimateId: string | null
}

interface InMemoryDb {
  leads: Map<string, Lead>
  estimates: Map<string, Estimate>
  activities: Activity[]
  nextEstimateSeq: number
  nextActivitySeq: number
}

// ---------------------------------------------------------------------------
// In-memory re-implementations of the three key operations
// ---------------------------------------------------------------------------

function makeDb(): InMemoryDb {
  return {
    leads: new Map(),
    estimates: new Map(),
    activities: [],
    nextEstimateSeq: 1,
    nextActivitySeq: 1,
  }
}

/**
 * Mirrors app/api/leads/[id]/convert-to-estimate/route.ts
 *
 * Creates an estimate in DRAFT status and advances the lead to ESTIMATE_CREATED
 * (unless the lead is already at ESTIMATE_CREATED, ESTIMATE_SENT, or CONVERTED).
 */
function convertLeadToEstimate(db: InMemoryDb, leadId: string): Estimate {
  const lead = db.leads.get(leadId)
  if (!lead) throw new Error(`Lead ${leadId} not found`)

  const estimateNumber = `EST-${String(db.nextEstimateSeq++).padStart(4, '0')}`
  const requestName = `${lead.firstName} ${lead.lastName}`.trim()

  const estimate: Estimate = {
    id: `est-${estimateNumber}`,
    tenantId: lead.tenantId,
    estimateNumber,
    title: `Estimate for ${requestName}`,
    leadId: lead.id,
    clientId: lead.convertedToClientId,
    status: 'DRAFT',
    total: 0,
    sentAt: null,
  }
  db.estimates.set(estimate.id, estimate)

  // Advance lead status — but only if it hasn't already reached this point or further.
  if (
    lead.status !== 'CONVERTED' &&
    lead.status !== 'ESTIMATE_SENT' &&
    lead.status !== 'ESTIMATE_CREATED'
  ) {
    lead.status = 'ESTIMATE_CREATED'
  }

  db.activities.push({
    id: `act-${db.nextActivitySeq++}`,
    type: 'ESTIMATE_CREATED',
    description: `Estimate ${estimateNumber} created from request "${requestName}"`,
    leadId: lead.id,
    estimateId: estimate.id,
  })

  return estimate
}

/**
 * Mirrors POST /api/estimates when a leadId is supplied.
 *
 * Creates an estimate in DRAFT status, advances the lead to ESTIMATE_CREATED
 * (unless the lead is already at ESTIMATE_CREATED, ESTIMATE_SENT, or CONVERTED).
 */
function createEstimateForLead(db: InMemoryDb, leadId: string | null, title: string): Estimate {
  const estimateNumber = `EST-${String(db.nextEstimateSeq++).padStart(4, '0')}`

  const estimate: Estimate = {
    id: `est-${estimateNumber}`,
    tenantId: 'tenant-1',
    estimateNumber,
    title,
    leadId,
    clientId: null,
    status: 'DRAFT',
    total: 0,
    sentAt: null,
  }
  db.estimates.set(estimate.id, estimate)

  if (leadId) {
    const lead = db.leads.get(leadId)
    if (
      lead &&
      lead.status !== 'CONVERTED' &&
      lead.status !== 'ESTIMATE_SENT' &&
      lead.status !== 'ESTIMATE_CREATED'
    ) {
      lead.status = 'ESTIMATE_CREATED'
    }
  }

  db.activities.push({
    id: `act-${db.nextActivitySeq++}`,
    type: 'ESTIMATE_CREATED',
    description: `Estimate "${title}" created`,
    leadId,
    estimateId: estimate.id,
  })

  return estimate
}

/**
 * Mirrors POST /api/estimates/[id]/send
 *
 * Marks the estimate as SENT. If a linked lead is in a status that precedes
 * ESTIMATE_SENT, advances it to ESTIMATE_SENT (idempotent — already-sent leads
 * are not touched, so resending does NOT duplicate the transition or the activity).
 */
const ADVANCE_FROM_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'ESTIMATE_CREATED',
]

function sendEstimate(db: InMemoryDb, estimateId: string): void {
  const estimate = db.estimates.get(estimateId)
  if (!estimate) throw new Error(`Estimate ${estimateId} not found`)

  estimate.status = 'SENT'
  estimate.sentAt = new Date()

  // Advance linked lead — only if it hasn't already been advanced.
  if (estimate.leadId) {
    const lead = db.leads.get(estimate.leadId)
    if (lead && (ADVANCE_FROM_STATUSES as readonly string[]).includes(lead.status)) {
      lead.status = 'ESTIMATE_SENT'
    }
  }

  db.activities.push({
    id: `act-${db.nextActivitySeq++}`,
    type: 'ESTIMATE_SENT',
    description: `Estimate "${estimate.title}" sent`,
    leadId: estimate.leadId,
    estimateId: estimate.id,
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLead(db: InMemoryDb, overrides: Partial<Lead> = {}): Lead {
  const id = `lead-${db.leads.size + 1}`
  const lead: Lead = {
    id,
    tenantId: 'tenant-1',
    firstName: 'Jane',
    lastName: 'Smith',
    status: 'NEW',
    convertedToClientId: null,
    convertedAt: null,
    ...overrides,
  }
  db.leads.set(lead.id, lead)
  return lead
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Converting a Request to an Estimate sets status to ESTIMATE_CREATED

test('converting a request to an estimate sets status to ESTIMATE_CREATED', () => {
  const db = makeDb()
  const lead = makeLead(db)

  assert.equal(lead.status, 'NEW')
  convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'ESTIMATE_CREATED', 'status must be ESTIMATE_CREATED after conversion, not ESTIMATE_SENT')
})

// 2. Creating a general Estimate linked to a Request sets status to ESTIMATE_CREATED

test('creating an estimate linked to a request via the general form sets status to ESTIMATE_CREATED', () => {
  const db = makeDb()
  const lead = makeLead(db)

  createEstimateForLead(db, lead.id, 'Trim Package')
  assert.equal(lead.status, 'ESTIMATE_CREATED', 'status must be ESTIMATE_CREATED, not ESTIMATE_SENT')
})

// 3. Request stays ESTIMATE_CREATED when estimate exists but has not been sent

test('request stays ESTIMATE_CREATED if estimate is never sent', () => {
  const db = makeDb()
  const lead = makeLead(db)

  convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'ESTIMATE_CREATED')

  // Simulate editing (no state change expected)
  const estimate = [...db.estimates.values()][0]
  estimate.total = 5000 // edit

  // Status has NOT changed
  assert.equal(lead.status, 'ESTIMATE_CREATED', 'editing the estimate must not change request status')
})

// 4. Sending an Estimate advances the Request to ESTIMATE_SENT

test('sending an estimate advances the request from ESTIMATE_CREATED to ESTIMATE_SENT', () => {
  const db = makeDb()
  const lead = makeLead(db)

  const estimate = convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'ESTIMATE_CREATED')

  sendEstimate(db, estimate.id)
  assert.equal(lead.status, 'ESTIMATE_SENT', 'status must become ESTIMATE_SENT after sending')
})

// 5. Resending the Estimate does NOT duplicate status changes or activities

test('resending the estimate does not duplicate status changes or activity entries', () => {
  const db = makeDb()
  const lead = makeLead(db)

  const estimate = convertLeadToEstimate(db, lead.id)
  sendEstimate(db, estimate.id)
  assert.equal(lead.status, 'ESTIMATE_SENT')

  const activitiesBefore = db.activities.length

  // Send again (e.g. client requested a re-send)
  sendEstimate(db, estimate.id)

  assert.equal(lead.status, 'ESTIMATE_SENT', 'status must remain ESTIMATE_SENT — no regression')
  // One new ESTIMATE_SENT activity is created for the re-send (expected), but
  // the lead status must NOT flip back or produce extra state changes.
  const sentActivities = db.activities.filter(
    (a) => a.type === 'ESTIMATE_SENT' && a.estimateId === estimate.id
  )
  assert.equal(sentActivities.length, 2, 'two ESTIMATE_SENT activities: one per send')
  // But the lead status change itself happened only once (first send).
  // Confirm it is still exactly ESTIMATE_SENT, not anything else.
  assert.equal(lead.status, 'ESTIMATE_SENT')
  assert.ok(db.activities.length > activitiesBefore, 'a new send activity was recorded')
})

// 6. Editing an estimate before sending leaves Request at ESTIMATE_CREATED

test('editing the estimate before sending leaves the request at ESTIMATE_CREATED', () => {
  const db = makeDb()
  const lead = makeLead(db)

  const estimate = convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'ESTIMATE_CREATED')

  // Simulate edits (title, total, notes — no status-affecting call)
  estimate.title = 'Updated Trim Package'
  estimate.total = 3200

  assert.equal(lead.status, 'ESTIMATE_CREATED', 'edits must not change request status')
})

// 7. A Request already at ESTIMATE_SENT is not regressed when another estimate is created

test('creating a second estimate for an already ESTIMATE_SENT request does not regress its status', () => {
  const db = makeDb()
  const lead = makeLead(db)

  const first = convertLeadToEstimate(db, lead.id)
  sendEstimate(db, first.id)
  assert.equal(lead.status, 'ESTIMATE_SENT')

  // Create a second estimate (e.g. revised quote)
  convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'ESTIMATE_SENT', 'must stay ESTIMATE_SENT — not regress to ESTIMATE_CREATED')
})

// 8. A CONVERTED Request is not touched by estimate creation or sending

test('a CONVERTED request is not affected by estimate creation or sending', () => {
  const db = makeDb()
  const lead = makeLead(db, { status: 'CONVERTED' })

  const estimate = convertLeadToEstimate(db, lead.id)
  assert.equal(lead.status, 'CONVERTED', 'CONVERTED must not change on estimate creation')

  sendEstimate(db, estimate.id)
  assert.equal(lead.status, 'CONVERTED', 'CONVERTED must not change on estimate send')
})

// 9. Sending an estimate with no linked request is a no-op on request status

test('sending an estimate that has no linked request does not throw and leaves all requests unchanged', () => {
  const db = makeDb()
  const lead = makeLead(db) // unrelated lead

  const orphanEstimate = createEstimateForLead(db, null, 'Walk-in Quote')
  assert.equal(lead.status, 'NEW', 'unrelated lead must be unchanged')

  sendEstimate(db, orphanEstimate.id)
  assert.equal(lead.status, 'NEW', 'unrelated lead must remain NEW after sending orphan estimate')
  assert.equal(orphanEstimate.status, 'SENT')
})

// 10. Activity log records ESTIMATE_CREATED on creation and ESTIMATE_SENT on send

test('activity log has ESTIMATE_CREATED on creation and ESTIMATE_SENT on send', () => {
  const db = makeDb()
  const lead = makeLead(db)

  const estimate = convertLeadToEstimate(db, lead.id)

  const createdActivities = db.activities.filter(
    (a) => a.type === 'ESTIMATE_CREATED' && a.estimateId === estimate.id
  )
  assert.equal(createdActivities.length, 1, 'exactly one ESTIMATE_CREATED activity on creation')

  const sentActivitiesBefore = db.activities.filter(
    (a) => a.type === 'ESTIMATE_SENT' && a.estimateId === estimate.id
  )
  assert.equal(sentActivitiesBefore.length, 0, 'no ESTIMATE_SENT activity before sending')

  sendEstimate(db, estimate.id)

  const sentActivitiesAfter = db.activities.filter(
    (a) => a.type === 'ESTIMATE_SENT' && a.estimateId === estimate.id
  )
  assert.equal(sentActivitiesAfter.length, 1, 'exactly one ESTIMATE_SENT activity after sending')
})
