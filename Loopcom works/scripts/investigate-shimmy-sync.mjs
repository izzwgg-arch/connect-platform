/**
 * Investigates why "Shimmy's Enterprises" customer record is not syncing to QuickBooks.
 * Run with: node scripts/investigate-shimmy-sync.mjs
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

// ---- 1. Test the esc() function used in QBO queries ----
function esc(value) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

console.log('=== ESC FUNCTION TEST ===')
const testName = "Shimmy's Enterprises"
const escaped = esc(testName)
console.log(`  Input:   ${testName}`)
console.log(`  Escaped: ${escaped}`)
// Show raw bytes of escaped string to detect any issues
console.log(`  Escaped (hex): ${Buffer.from(escaped).toString('hex')}`)
console.log(`  Apostrophe backslash escape = ${escaped.includes("\\'")} (should be true)`)
console.log(`  Query:   select * from Customer where DisplayName='${escaped}' maxresults 1`)
console.log()

// ---- 2. Find the client record — try various spellings ----
console.log('=== CLIENT RECORD LOOKUP (broad search) ===')

// Try different name variations
const searchTerms = ['shimmy', 'shimmys', "shimmy's", 'enterprise']
for (const term of searchTerms) {
  const results = await p.client.findMany({
    where: { name: { contains: term, mode: 'insensitive' } },
    select: { id: true, name: true, companyName: true, tenantId: true, isActive: true },
  })
  if (results.length > 0) {
    console.log(`  Matches for "${term}":`)
    for (const r of results) {
      console.log(`    id=${r.id} name="${r.name}" companyName="${r.companyName}" active=${r.isActive}`)
    }
  }
}

// Also search companyName
const companyMatches = await p.client.findMany({
  where: { companyName: { contains: 'shimmy', mode: 'insensitive' } },
  select: { id: true, name: true, companyName: true, tenantId: true, isActive: true },
})
if (companyMatches.length > 0) {
  console.log('  companyName matches for "shimmy":')
  for (const r of companyMatches) {
    console.log(`    id=${r.id} name="${r.name}" companyName="${r.companyName}"`)
  }
}

// List all clients to see the full set
console.log()
console.log('=== ALL CLIENTS IN DATABASE ===')
const allClients = await p.client.findMany({
  select: { id: true, name: true, companyName: true, tenantId: true, isActive: true },
  orderBy: { name: 'asc' },
  take: 50,
})
if (allClients.length === 0) {
  console.log('  No clients found in database')
} else {
  console.log(`  Found ${allClients.length} clients:`)
  for (const c of allClients) {
    console.log(`    [${c.isActive ? 'ACTIVE' : 'INACTIVE'}] id=${c.id} name="${c.name}" company="${c.companyName}" tenant=${c.tenantId}`)
  }
}

// ---- 3. All tenants ----
console.log()
console.log('=== ALL TENANTS ===')
const tenants = await p.tenant.findMany({
  select: { id: true, name: true },
  take: 20,
})
for (const t of tenants) {
  console.log(`  id=${t.id} name="${t.name}"`)
}

// ---- 4. QBO integrations ----
console.log()
console.log('=== QBO INTEGRATIONS ===')
const integrations = await p.quickBooksIntegration.findMany({
  select: {
    id: true,
    tenantId: true,
    isConnected: true,
    realmId: true,
    lastSyncAt: true,
    lastSyncStatus: true,
    lastSyncError: true,
  },
})
for (const qi of integrations) {
  console.log(`  id=${qi.id} tenantId=${qi.tenantId} connected=${qi.isConnected} realm=${qi.realmId}`)
  if (qi.lastSyncError) console.log(`    lastSyncError: ${qi.lastSyncError}`)
}

// ---- 5. Recent QBO sync logs (all types, last 20) ----
console.log()
console.log('=== RECENT QBO SYNC LOGS (last 20, all types) ===')
const recentLogs = await p.quickBooksSyncLog.findMany({
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: { type: true, entityId: true, action: true, status: true, error: true, qboId: true, createdAt: true },
})
for (const log of recentLogs) {
  console.log(`  [${log.createdAt?.toISOString()}] type=${log.type} action=${log.action} status=${log.status} entityId=${log.entityId} qboId=${log.qboId}`)
  if (log.error) console.log(`    error: ${log.error}`)
}

// ---- 6. All pending/failed sync jobs ----
console.log()
console.log('=== ALL SYNC JOBS ===')
const jobs = await p.qboSyncJob.findMany({
  orderBy: { nextRetryAt: 'desc' },
  take: 20,
})
if (jobs.length === 0) {
  console.log('  No sync jobs found')
} else {
  for (const job of jobs) {
    console.log(`  [${job.id}] type=${job.entityType} entityId=${job.entityId} status=${job.status} retries=${job.retryCount}`)
    if (job.lastError) console.log(`    lastError: ${job.lastError}`)
  }
}

await p.$disconnect()
