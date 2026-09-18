/** Shared Prisma OR clauses for job site address search (partial, case-insensitive). */

function ilike(search: string) {
  return { contains: search, mode: 'insensitive' as const }
}

function jobSiteAddressPartsOr(search: string) {
  return [
    { street: ilike(search) },
    { city: ilike(search) },
    { state: ilike(search) },
    { zipCode: ilike(search) },
  ]
}

function jobSiteAddressesSomeFilter(search: string) {
  return {
    some: {
      type: 'job_site' as const,
      OR: jobSiteAddressPartsOr(search),
    },
  }
}

/** Search job records by their job_site address parts. */
export function jobRecordJobSiteAddressSearchClauses(search: string) {
  return [{ addresses: jobSiteAddressesSomeFilter(search) }]
}

/** Search records linked to a job by that job's job_site address parts. */
export function relatedJobJobSiteAddressSearchClauses(search: string) {
  return [{ job: { addresses: jobSiteAddressesSomeFilter(search) } }]
}

/** Search estimates by jobSiteAddress text, lead fallback, or linked job address. */
export function estimateJobSiteAddressSearchClauses(search: string) {
  return [
    { jobSiteAddress: ilike(search) },
    { lead: { jobSiteAddress: ilike(search) } },
    ...relatedJobJobSiteAddressSearchClauses(search),
  ]
}

/** Search invoices by estimate jobSiteAddress or linked job address. */
export function invoiceJobSiteAddressSearchClauses(search: string) {
  return [
    { estimate: { jobSiteAddress: ilike(search) } },
    ...relatedJobJobSiteAddressSearchClauses(search),
  ]
}

/** Search purchase orders by linked job's job_site address. */
export function purchaseOrderJobSiteAddressSearchClauses(search: string) {
  return relatedJobJobSiteAddressSearchClauses(search)
}

/** Search leads/requests by jobSiteAddress text field. */
export function leadJobSiteAddressSearchClauses(search: string) {
  return [{ jobSiteAddress: ilike(search) }]
}
