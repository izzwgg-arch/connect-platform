/**
 * Verify job site address search against live data.
 * Run: npx tsx scripts/verify-job-site-address-search.ts
 */
import { PrismaClient } from '@prisma/client'
import {
  estimateJobSiteAddressSearchClauses,
  invoiceJobSiteAddressSearchClauses,
  jobRecordJobSiteAddressSearchClauses,
  leadJobSiteAddressSearchClauses,
  purchaseOrderJobSiteAddressSearchClauses,
} from '../lib/search/job-site-address'

const prisma = new PrismaClient()

type CheckResult = {
  entity: string
  sampleAddress: string
  term: string
  matched: boolean
  count: number
}

async function sampleTenantId() {
  const row = await prisma.tenant.findFirst({ select: { id: true } })
  return row?.id || null
}

async function verifyEntity(
  entity: string,
  sampleAddress: string,
  term: string,
  countFn: (tenantId: string, search: string) => Promise<number>
): Promise<CheckResult> {
  const tenantId = await sampleTenantId()
  if (!tenantId) {
    return { entity, sampleAddress, term, matched: false, count: 0 }
  }
  const count = await countFn(tenantId, term)
  return { entity, sampleAddress, term, matched: count > 0, count }
}

function pickSearchTerm(address: string): string {
  const parts = address.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean)
  if (parts[0]) {
    const words = parts[0].split(/\s+/).filter(Boolean)
    if (words.length >= 2) return words[1]
    return words[0]
  }
  return address.slice(0, 5)
}

async function main() {
  const tenantId = await sampleTenantId()
  if (!tenantId) {
    console.log(JSON.stringify({ ok: false, error: 'No tenant found in database' }, null, 2))
    process.exit(1)
  }

  const results: CheckResult[] = []
  const existingSearchChecks: Array<{ entity: string; term: string; matched: boolean; count: number }> = []

  const estimate = await prisma.estimate.findFirst({
    where: { tenantId, jobSiteAddress: { not: null } },
    select: { jobSiteAddress: true, estimateNumber: true },
  })
  if (estimate?.jobSiteAddress) {
    const term = pickSearchTerm(estimate.jobSiteAddress)
    results.push(
      await verifyEntity('estimates', estimate.jobSiteAddress, term, (tid, search) =>
        prisma.estimate.count({
          where: {
            tenantId: tid,
            OR: [
              { estimateNumber: { contains: search, mode: 'insensitive' } },
              { title: { contains: search, mode: 'insensitive' } },
              ...estimateJobSiteAddressSearchClauses(search),
            ],
          },
        })
      )
    )
    if (estimate.estimateNumber) {
      const count = await prisma.estimate.count({
        where: {
          tenantId,
          OR: [
            { estimateNumber: { contains: estimate.estimateNumber, mode: 'insensitive' } },
            { title: { contains: estimate.estimateNumber, mode: 'insensitive' } },
            ...estimateJobSiteAddressSearchClauses(estimate.estimateNumber),
          ],
        },
      })
      existingSearchChecks.push({
        entity: 'estimates',
        term: estimate.estimateNumber,
        matched: count > 0,
        count,
      })
    }
  }

  const invoice = await prisma.invoice.findFirst({
    where: {
      tenantId,
      OR: [
        { estimate: { jobSiteAddress: { not: null } } },
        { job: { addresses: { some: { type: 'job_site' } } } },
      ],
    },
    select: {
      invoiceNumber: true,
      estimate: { select: { jobSiteAddress: true } },
      job: {
        select: {
          addresses: {
            where: { type: 'job_site' },
            take: 1,
            select: { street: true, city: true, state: true, zipCode: true },
          },
        },
      },
    },
  })
  if (invoice) {
    const address =
      invoice.estimate?.jobSiteAddress ||
      [invoice.job?.addresses?.[0]?.street, invoice.job?.addresses?.[0]?.city]
        .filter(Boolean)
        .join(', ')
    if (address) {
      const term = pickSearchTerm(address)
      results.push(
        await verifyEntity('invoices', address, term, (tid, search) =>
          prisma.invoice.count({
            where: {
              tenantId: tid,
              OR: [
                { invoiceNumber: { contains: search, mode: 'insensitive' } },
                { title: { contains: search, mode: 'insensitive' } },
                ...invoiceJobSiteAddressSearchClauses(search),
              ],
            },
          })
        )
      )
    }
    if (invoice.invoiceNumber) {
      const count = await prisma.invoice.count({
        where: {
          tenantId,
          OR: [
            { invoiceNumber: { contains: invoice.invoiceNumber, mode: 'insensitive' } },
            { title: { contains: invoice.invoiceNumber, mode: 'insensitive' } },
            ...invoiceJobSiteAddressSearchClauses(invoice.invoiceNumber),
          ],
        },
      })
      existingSearchChecks.push({
        entity: 'invoices',
        term: invoice.invoiceNumber,
        matched: count > 0,
        count,
      })
    }
  }

  const po = await prisma.purchaseOrder.findFirst({
    where: { tenantId, job: { addresses: { some: { type: 'job_site' } } } },
    select: {
      poNumber: true,
      job: {
        select: {
          addresses: {
            where: { type: 'job_site' },
            take: 1,
            select: { street: true, city: true },
          },
        },
      },
    },
  })
  if (po?.job?.addresses?.[0]) {
    const addr = po.job.addresses[0]
    const address = [addr.street, addr.city].filter(Boolean).join(', ')
    const term = pickSearchTerm(address)
    results.push(
      await verifyEntity('purchase_orders', address, term, (tid, search) =>
        prisma.purchaseOrder.count({
          where: {
            tenantId: tid,
            OR: [
              { poNumber: { contains: search, mode: 'insensitive' } },
              { vendor: { contains: search, mode: 'insensitive' } },
              ...purchaseOrderJobSiteAddressSearchClauses(search),
            ],
          },
        })
      )
    )
    if (po.poNumber) {
      const count = await prisma.purchaseOrder.count({
        where: {
          tenantId,
          OR: [
            { poNumber: { contains: po.poNumber, mode: 'insensitive' } },
            { vendor: { contains: po.poNumber, mode: 'insensitive' } },
            ...purchaseOrderJobSiteAddressSearchClauses(po.poNumber),
          ],
        },
      })
      existingSearchChecks.push({
        entity: 'purchase_orders',
        term: po.poNumber,
        matched: count > 0,
        count,
      })
    }
  }

  const lead = await prisma.lead.findFirst({
    where: { tenantId, jobSiteAddress: { not: null } },
    select: { jobSiteAddress: true, firstName: true },
  })
  if (lead?.jobSiteAddress) {
    const term = pickSearchTerm(lead.jobSiteAddress)
    results.push(
      await verifyEntity('requests', lead.jobSiteAddress, term, (tid, search) =>
        prisma.lead.count({
          where: {
            tenantId: tid,
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              ...leadJobSiteAddressSearchClauses(search),
            ],
          },
        })
      )
    )
    if (lead.firstName) {
      const count = await prisma.lead.count({
        where: {
          tenantId,
          OR: [
            { firstName: { contains: lead.firstName, mode: 'insensitive' } },
            ...leadJobSiteAddressSearchClauses(lead.firstName),
          ],
        },
      })
      existingSearchChecks.push({
        entity: 'requests',
        term: lead.firstName,
        matched: count > 0,
        count,
      })
    }
  }

  const job = await prisma.job.findFirst({
    where: { tenantId, addresses: { some: { type: 'job_site' } } },
    select: {
      jobNumber: true,
      addresses: {
        where: { type: 'job_site' },
        take: 1,
        select: { street: true, city: true },
      },
    },
  })
  if (job?.addresses?.[0]) {
    const address = [job.addresses[0].street, job.addresses[0].city].filter(Boolean).join(', ')
    const term = pickSearchTerm(address)
    results.push(
      await verifyEntity('jobs', address, term, (tid, search) =>
        prisma.job.count({
          where: {
            tenantId: tid,
            OR: [
              { jobNumber: { contains: search, mode: 'insensitive' } },
              { title: { contains: search, mode: 'insensitive' } },
              ...jobRecordJobSiteAddressSearchClauses(search),
            ],
          },
        })
      )
    )
    if (job.jobNumber) {
      const count = await prisma.job.count({
        where: {
          tenantId,
          OR: [
            { jobNumber: { contains: job.jobNumber, mode: 'insensitive' } },
            { title: { contains: job.jobNumber, mode: 'insensitive' } },
            ...jobRecordJobSiteAddressSearchClauses(job.jobNumber),
          ],
        },
      })
      existingSearchChecks.push({
        entity: 'jobs',
        term: job.jobNumber,
        matched: count > 0,
        count,
      })
    }
  }

  const caseCheck = estimate?.jobSiteAddress
    ? await prisma.estimate.count({
        where: {
          tenantId,
          OR: estimateJobSiteAddressSearchClauses(pickSearchTerm(estimate.jobSiteAddress).toUpperCase()),
        },
      })
    : 0

  const report = {
    ok: results.every((r) => r.matched) && existingSearchChecks.every((r) => r.matched),
    tenantId,
    jobSiteAddressSearch: results,
    existingSearchPreserved: existingSearchChecks,
    caseInsensitiveEstimateMatch: caseCheck > 0,
    note:
      results.length === 0
        ? 'No records with job site addresses found; unit tests cover query structure.'
        : undefined,
  }

  console.log(JSON.stringify(report, null, 2))
  await prisma.$disconnect()
  process.exit(report.ok || results.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
