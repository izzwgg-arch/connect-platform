/**
 * Seeds the "Shimmy's Enterprises" client record into the dev database so the
 * sync investigation can be demonstrated end-to-end.
 *
 * Usage: node scripts/seed-shimmy-enterprises.mjs
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

// Find the first (only) tenant
const tenant = await p.tenant.findFirst()
if (!tenant) {
  console.error('No tenant found — run prisma db seed first')
  process.exit(1)
}

console.log(`Using tenant: ${tenant.id} (${tenant.name})`)

// Create the client
const existing = await p.client.findFirst({
  where: { name: "Shimmy's Enterprises", tenantId: tenant.id },
})

let client
if (existing) {
  console.log(`Client already exists: ${existing.id}`)
  client = existing
} else {
  client = await p.client.create({
    data: {
      tenantId: tenant.id,
      name: "Shimmy's Enterprises",
      companyName: "Shimmy's Enterprises LLC",
      email: 'info@shimmyenterprises.com',
      phone: '212-555-0199',
      isActive: true,
      addresses: {
        create: {
          type: 'billing',
          street: '88 Canal Street',
          city: 'New York',
          state: 'NY',
          zipCode: '10002',
          country: 'US',
        },
      },
    },
  })
  console.log(`Created client: ${client.id} — "${client.name}"`)
}

// Ensure QBO integration row exists for the tenant (without real tokens,
// so sync will fail at the session layer — which is correct for dev)
const qboInt = await p.quickBooksIntegration.upsert({
  where: { tenantId: tenant.id },
  update: {},
  create: {
    tenantId: tenant.id,
    isConnected: false,
  },
})
console.log(`QBO integration: ${qboInt.id} (connected=${qboInt.isConnected})`)

// Verify
const fetched = await p.client.findFirst({
  where: { id: client.id },
  include: { addresses: true },
})
console.log()
console.log('=== Seeded Client Record ===')
console.log(JSON.stringify(fetched, null, 2))

await p.$disconnect()
console.log()
console.log('Done. Re-run investigate-shimmy-sync.mjs to confirm the record is visible.')
