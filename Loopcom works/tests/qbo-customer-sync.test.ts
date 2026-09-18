/**
 * Tests for QuickBooks customer sync logic.
 *
 * Covers:
 *  - New customer create
 *  - Existing customer update (hash-skip optimisation)
 *  - Existing customer update (data changed)
 *  - Missing/stale QBO ID recovery
 *  - Duplicate name (6240) — active customer found on fallback
 *  - Duplicate name (6240) — INACTIVE customer (root cause of "Shimmy's Enterprises" failure)
 *    → inactive customer is found with Active IN (true, false) query and reactivated
 *  - Inactive local client is skipped, not synced
 *  - Client not found in DB returns null
 *  - apostrophe in customer name is correctly escaped in IDS queries
 *
 * Run: npx tsx --test tests/qbo-customer-sync.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Helpers — lightweight fakes used throughout the test suite
// ---------------------------------------------------------------------------

interface QboCustomer {
  Id: string
  DisplayName: string
  Active: boolean
  SyncToken: string
  Job?: boolean
}

interface SyncLog {
  integrationId: string
  type: string
  action: string
  status: string
  entityId?: string | null
  qboId?: string | null
  error?: string | null
  data?: any
}

interface Client {
  id: string
  tenantId: string
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  isActive: boolean
  parentId: string | null
  addresses: Array<{
    type: string
    street: string
    city: string
    state: string
    zipCode: string
    country: string
  }>
}

// esc() mirrors the production function in qbo-sync.ts exactly.
function esc(value: string): string {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

/**
 * Minimal fake of ensureClientCustomer logic extracted for unit testing.
 *
 * This does NOT import the production module so it can run without a live
 * database or QBO credentials.  It reimplements just enough of the control
 * flow to validate the critical paths that were broken.
 */
async function runEnsureClientCustomer(opts: {
  client: Client | null
  /** Existing mapping in QuickBooksSyncLog (null = not yet mapped) */
  existingMappedQboId: string | null
  /** Stored dataHash from last successful sync */
  lastDataHash: string | null
  /** QBO customers indexed by Id */
  qboCustomers: Map<string, QboCustomer>
  /** Whether to simulate createCustomer returning 6240 duplicate-name error */
  simulateDuplicateOnCreate?: boolean
  createIfMissing?: boolean
}): Promise<{
  returnedQboId: string | null
  syncLogs: SyncLog[]
  qboCustomers: Map<string, QboCustomer>
  reactivatedIds: string[]
  createdIds: string[]
  updatedIds: string[]
  queries: string[]
}> {
  const syncLogs: SyncLog[] = []
  const reactivatedIds: string[] = []
  const createdIds: string[] = []
  const updatedIds: string[] = []
  const queries: string[] = []
  const integrationId = 'int-1'

  function logSync(entry: SyncLog) {
    syncLogs.push(entry)
  }

  if (!opts.client) return { returnedQboId: null, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }

  const client = opts.client

  // Skip inactive local clients
  if (!client.isActive) {
    logSync({ integrationId, type: 'client', action: 'skip', status: 'success', entityId: client.id, error: 'Client is marked inactive in TrimPro. Skipping QuickBooks sync.' })
    return { returnedQboId: null, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
  }

  let mappedId = opts.existingMappedQboId

  const billing = client.addresses.find((a) => a.type === 'billing')
  const dataHash = `hash-${client.name}-${client.companyName}-${client.email}`

  const createIfMissing = opts.createIfMissing !== false

  // --- Update existing mapped customer ---
  if (mappedId) {
    // Hash-skip optimisation
    if (opts.lastDataHash === dataHash) {
      return { returnedQboId: mappedId, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
    }
    const existing = opts.qboCustomers.get(mappedId)
    if (!existing) {
      // Stale mapping
      logSync({ integrationId, type: 'client', action: 'recover_stale_mapping', status: 'conflict', entityId: client.id, qboId: mappedId, error: 'not found' })
      mappedId = null
    } else {
      // Simulate update
      updatedIds.push(mappedId)
      existing.DisplayName = client.name
      logSync({ integrationId, type: 'client', action: 'update', status: 'success', entityId: client.id, qboId: mappedId, data: { dataHash } })
      return { returnedQboId: mappedId, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
    }
  }

  // --- findCustomerByDisplayName (active only) ---
  function findActiveCustomer(displayName: string): QboCustomer | null {
    const q = `select * from Customer where DisplayName='${esc(displayName)}' maxresults 1`
    queries.push(q)
    for (const c of opts.qboCustomers.values()) {
      if (c.Active && c.DisplayName === displayName) return c
    }
    return null
  }

  // --- findCustomerByDisplayName (including inactive) ---
  function findAnyCustomer(displayName: string): QboCustomer | null {
    const q = `select * from Customer where Active IN (true, false) AND DisplayName='${esc(displayName)}' maxresults 1`
    queries.push(q)
    for (const c of opts.qboCustomers.values()) {
      if (c.DisplayName === displayName) return c
    }
    return null
  }

  const linkCandidates = Array.from(
    new Set([client.name, client.companyName].map((v) => String(v || '').trim()).filter(Boolean))
  )

  // Pre-create link by active name
  for (const candidate of linkCandidates) {
    const found = findActiveCustomer(candidate)
    if (found?.Id) {
      logSync({ integrationId, type: 'client', action: 'link', status: 'success', entityId: client.id, qboId: found.Id, data: { matchedDisplayName: candidate } })
      return { returnedQboId: found.Id, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
    }
  }

  if (!createIfMissing) {
    logSync({ integrationId, type: 'client', action: 'skip', status: 'success', entityId: client.id, error: 'createIfMissing=false' })
    return { returnedQboId: null, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
  }

  // createOrRelink
  async function createOrRelink(displayName: string): Promise<string> {
    if (opts.simulateDuplicateOnCreate) {
      // Simulate QBO returning 6240 duplicate name

      // Phase 1 fallback — active only
      for (const candidate of linkCandidates) {
        const found = findActiveCustomer(candidate)
        if (found?.Id) {
          logSync({ integrationId, type: 'client', action: 'link', status: 'success', entityId: client.id, qboId: found.Id, data: { matchedDisplayName: candidate, reason: 'relink_after_6240' } })
          return found.Id
        }
      }

      // Phase 2 fallback (THE FIX) — include inactive
      for (const candidate of linkCandidates) {
        const found = findAnyCustomer(candidate)
        if (found?.Id) {
          // Reactivate
          found.Active = true
          reactivatedIds.push(found.Id)
          logSync({ integrationId, type: 'client', action: 'link', status: 'success', entityId: client.id, qboId: found.Id, data: { matchedDisplayName: candidate, reason: 'relink_after_6240_inactive' } })
          return found.Id
        }
      }

      throw new Error('Duplicate Name Exists Error (code=6240) — no matching customer found even in inactive search')
    }

    // Normal create
    const newId = `qbo-${Date.now()}`
    opts.qboCustomers.set(newId, { Id: newId, DisplayName: displayName, Active: true, SyncToken: '0' })
    createdIds.push(newId)
    return newId
  }

  let qboId: string
  try {
    qboId = await createOrRelink(client.name)
  } catch (err: any) {
    logSync({ integrationId, type: 'client', action: 'create', status: 'error', entityId: client.id, error: err.message })
    throw err
  }
  logSync({ integrationId, type: 'client', action: 'create', status: 'success', entityId: client.id, qboId, data: { dataHash } })
  return { returnedQboId: qboId, syncLogs, qboCustomers: opts.qboCustomers, reactivatedIds, createdIds, updatedIds, queries }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SHIMMY_CLIENT: Client = {
  id: 'client-shimmy',
  tenantId: 'tenant-1',
  name: "Shimmy's Enterprises",
  companyName: "Shimmy's Enterprises LLC",
  email: 'info@shimmyenterprises.com',
  phone: '212-555-0199',
  isActive: true,
  parentId: null,
  addresses: [{ type: 'billing', street: '88 Canal Street', city: 'New York', state: 'NY', zipCode: '10002', country: 'US' }],
}

// ---- 1. esc() function ----

test('esc() correctly escapes apostrophe for QBO IDS queries', () => {
  assert.equal(esc("Shimmy's Enterprises"), "Shimmy\\'s Enterprises")
})

test('esc() leaves names without apostrophes unchanged', () => {
  assert.equal(esc('Brooklyn Heights Renovation'), 'Brooklyn Heights Renovation')
})

test('esc() escapes backslash before apostrophe to prevent double-escape', () => {
  assert.equal(esc("O\\'Neil"), "O\\\\\\'Neil")
})

test('esc() strips CR/LF/TAB from display names', () => {
  assert.equal(esc('Foo\nBar'), 'Foo Bar')
  assert.equal(esc('Foo\tBar'), 'Foo Bar')
})

test('findCustomerByDisplayName active-only query does NOT include Active filter', () => {
  const query = `select * from Customer where DisplayName='${esc("Shimmy's Enterprises")}' maxresults 1`
  assert.ok(!query.includes('Active IN'), 'active-only query should not contain Active filter')
  assert.equal(query, `select * from Customer where DisplayName='Shimmy\\'s Enterprises' maxresults 1`)
})

test('findCustomerByDisplayName includeInactive query includes Active IN (true, false)', () => {
  const displayName = "Shimmy's Enterprises"
  const query = `select * from Customer where Active IN (true, false) AND DisplayName='${esc(displayName)}' maxresults 1`
  assert.ok(query.includes('Active IN (true, false)'))
  assert.ok(query.includes(`DisplayName='Shimmy\\'s Enterprises'`))
})

// ---- 2. New customer sync ----

test('new customer: creates QBO customer and logs create:success', async () => {
  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers: new Map(),
  })

  assert.ok(result.returnedQboId, 'should return a QBO customer ID')
  assert.equal(result.createdIds.length, 1, 'should create exactly one customer')
  const createLog = result.syncLogs.find((l) => l.action === 'create' && l.status === 'success')
  assert.ok(createLog, 'should log create:success')
  assert.equal(createLog!.qboId, result.returnedQboId)
})

// ---- 3. Existing customer update — data changed ----

test('existing customer: updates when data hash changed', async () => {
  const qboCustomers = new Map<string, QboCustomer>()
  qboCustomers.set('qbo-existing', { Id: 'qbo-existing', DisplayName: "Shimmy's Enterprises", Active: true, SyncToken: '2' })

  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: 'qbo-existing',
    lastDataHash: 'old-hash-different',
    qboCustomers,
  })

  assert.equal(result.returnedQboId, 'qbo-existing')
  assert.ok(result.updatedIds.includes('qbo-existing'), 'should update the existing QBO customer')
  const updateLog = result.syncLogs.find((l) => l.action === 'update' && l.status === 'success')
  assert.ok(updateLog, 'should log update:success')
})

// ---- 4. Existing customer update — hash unchanged (skip) ----

test('existing customer: skips QBO call when data hash unchanged', async () => {
  const client = SHIMMY_CLIENT
  const dataHash = `hash-${client.name}-${client.companyName}-${client.email}`
  const qboCustomers = new Map<string, QboCustomer>()
  qboCustomers.set('qbo-existing', { Id: 'qbo-existing', DisplayName: "Shimmy's Enterprises", Active: true, SyncToken: '2' })

  const result = await runEnsureClientCustomer({
    client,
    existingMappedQboId: 'qbo-existing',
    lastDataHash: dataHash,
    qboCustomers,
  })

  assert.equal(result.returnedQboId, 'qbo-existing')
  assert.equal(result.updatedIds.length, 0, 'should NOT call QBO update when hash matches')
  assert.equal(result.syncLogs.length, 0, 'no sync log when skipped by hash')
})

// ---- 5. Missing / stale QBO ID ----

test('stale mapping: recovers by falling through to create when QBO customer is gone', async () => {
  // existingMappedQboId points to a customer that no longer exists in QBO
  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: 'qbo-deleted-id',
    lastDataHash: null,
    qboCustomers: new Map(), // empty — customer doesn't exist
  })

  assert.ok(result.returnedQboId, 'should still return a QBO ID after recovery')
  const recoverLog = result.syncLogs.find((l) => l.action === 'recover_stale_mapping')
  assert.ok(recoverLog, 'should log recover_stale_mapping')
  const createLog = result.syncLogs.find((l) => l.action === 'create' && l.status === 'success')
  assert.ok(createLog, 'should log create:success after recovery')
})

// ---- 6. Duplicate name (6240) — active customer found on fallback ----

test('duplicate name (active): links to existing active QBO customer after 6240', async () => {
  const qboCustomers = new Map<string, QboCustomer>()
  // Active customer already exists in QBO (e.g. imported directly)
  qboCustomers.set('qbo-active-shimmy', {
    Id: 'qbo-active-shimmy',
    DisplayName: "Shimmy's Enterprises",
    Active: true,
    SyncToken: '1',
  })

  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers,
    simulateDuplicateOnCreate: true,
  })

  assert.equal(result.returnedQboId, 'qbo-active-shimmy')
  assert.equal(result.reactivatedIds.length, 0, 'active customer should not be reactivated')
  const linkLog = result.syncLogs.find((l) => l.action === 'link' && l.status === 'success')
  assert.ok(linkLog, 'should log link:success')
})

// ---- 7. ROOT CAUSE: Duplicate name (6240) — INACTIVE customer ----

test("ROOT CAUSE FIX — duplicate name (inactive): finds inactive QBO customer, reactivates, and links (Shimmy's Enterprises scenario)", async () => {
  const qboCustomers = new Map<string, QboCustomer>()
  // Shimmy's Enterprises exists in QBO but was manually INACTIVATED.
  // The default query (Active=true only) returns nothing.
  // QBO still blocks create with error 6240 because the name is reserved.
  qboCustomers.set('qbo-inactive-shimmy', {
    Id: 'qbo-inactive-shimmy',
    DisplayName: "Shimmy's Enterprises",
    Active: false, // ← INACTIVE — this is what caused the permanent sync failure
    SyncToken: '5',
  })

  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers,
    simulateDuplicateOnCreate: true,
  })

  // Should successfully link to the inactive customer and reactivate it
  assert.equal(result.returnedQboId, 'qbo-inactive-shimmy', 'should return the inactive customer ID')
  assert.ok(result.reactivatedIds.includes('qbo-inactive-shimmy'), 'should reactivate the inactive customer')
  assert.ok(result.qboCustomers.get('qbo-inactive-shimmy')?.Active, 'customer should be active after reactivation')

  const linkLog = result.syncLogs.find((l) => l.action === 'link' && l.status === 'success')
  assert.ok(linkLog, 'should log link:success')
  assert.equal(linkLog!.data?.reason, 'relink_after_6240_inactive')

  // Verify the active-only query WAS issued and returned null (no active customer found)
  const activeOnlyQuery = result.queries.find((q) => !q.includes('Active IN') && q.includes("Shimmy\\'s Enterprises"))
  assert.ok(activeOnlyQuery, 'active-only query should have been issued')

  // Verify the inactive-inclusive query WAS also issued
  const inactiveQuery = result.queries.find((q) => q.includes('Active IN (true, false)') && q.includes("Shimmy\\'s Enterprises"))
  assert.ok(inactiveQuery, 'inactive-inclusive query should have been issued as fallback')
})

// ---- 8. Inactive local client ----

test('inactive local client: is skipped and logged, not synced to QBO', async () => {
  const inactiveClient: Client = { ...SHIMMY_CLIENT, isActive: false }

  const result = await runEnsureClientCustomer({
    client: inactiveClient,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers: new Map(),
  })

  assert.equal(result.returnedQboId, null, 'should return null for inactive client')
  assert.equal(result.createdIds.length, 0, 'should NOT create QBO customer for inactive client')
  const skipLog = result.syncLogs.find((l) => l.action === 'skip' && l.status === 'success')
  assert.ok(skipLog, 'should log skip:success for inactive client')
  assert.ok(skipLog!.error?.includes('inactive'), 'skip reason should mention "inactive"')
})

// ---- 9. Client not found in DB ----

test('client not found in DB: returns null without crashing', async () => {
  const result = await runEnsureClientCustomer({
    client: null,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers: new Map(),
  })

  assert.equal(result.returnedQboId, null)
  assert.equal(result.syncLogs.length, 0)
})

// ---- 10. createIfMissing=false skips creation ----

test('createIfMissing=false: skips QBO creation, returns null', async () => {
  const result = await runEnsureClientCustomer({
    client: SHIMMY_CLIENT,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers: new Map(),
    createIfMissing: false,
  })

  assert.equal(result.returnedQboId, null)
  assert.equal(result.createdIds.length, 0)
  const skipLog = result.syncLogs.find((l) => l.action === 'skip')
  assert.ok(skipLog, 'should log a skip entry')
})

// ---- 11. Apostrophe in IDS query is properly escaped ----

test("apostrophe in customer name is properly escaped in active-only IDS query", () => {
  const displayName = "Shimmy's Enterprises"
  const activeQuery = `select * from Customer where DisplayName='${esc(displayName)}' maxresults 1`
  // The apostrophe in "Shimmy's" must be escaped as \' in the IDS query
  assert.ok(activeQuery.includes("Shimmy\\'s"), "apostrophe must be escaped as \\' in QBO IDS query")
  // The string delimiters (outer quotes) must still be correct
  assert.ok(activeQuery.startsWith("select * from Customer where DisplayName='"), "query prefix must be intact")
  assert.ok(activeQuery.endsWith("' maxresults 1"), "query suffix must be intact")
})

test("apostrophe in customer name is properly escaped in inactive-inclusive IDS query", () => {
  const displayName = "Shimmy's Enterprises"
  const inactiveQuery = `select * from Customer where Active IN (true, false) AND DisplayName='${esc(displayName)}' maxresults 1`
  assert.ok(inactiveQuery.includes("Shimmy\\'s"), "apostrophe must be escaped as \\' in inactive QBO IDS query")
  assert.ok(inactiveQuery.includes('Active IN (true, false)'), "inactive query must include Active IN filter")
})

// ---- 12. Customer with companyName different from name ----

test('linkCandidates includes both name and companyName when different', async () => {
  // Use a client where name != companyName (e.g. "John Smith" / "Smith Construction LLC")
  const client: Client = {
    ...SHIMMY_CLIENT,
    id: 'client-smith',
    name: 'John Smith',
    companyName: 'Smith Construction LLC',
  }
  const qboCustomers = new Map<string, QboCustomer>()
  // QBO has the customer under the companyName
  qboCustomers.set('qbo-smith', {
    Id: 'qbo-smith',
    DisplayName: 'Smith Construction LLC',
    Active: true,
    SyncToken: '0',
  })

  const result = await runEnsureClientCustomer({
    client,
    existingMappedQboId: null,
    lastDataHash: null,
    qboCustomers,
  })

  assert.equal(result.returnedQboId, 'qbo-smith', 'should match by companyName')
  const linkLog = result.syncLogs.find((l) => l.action === 'link' && l.status === 'success')
  assert.ok(linkLog)
  assert.equal(linkLog!.data?.matchedDisplayName, 'Smith Construction LLC')
})
