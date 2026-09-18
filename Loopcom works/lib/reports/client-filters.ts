import { prisma } from '@/lib/prisma'
import { ilike } from '@/lib/search/prisma-filters'

/**
 * Resolves which client IDs a report should include for a given clientId filter.
 * - No clientId: returns null (no filter — all customers).
 * - clientId set, rollupSubClients=true: expands to [clientId, ...its sub-client IDs]
 *   so a parent account's report includes its sub-customers' data merged in.
 * - clientId set, rollupSubClients=false: returns just [clientId].
 */
export async function resolveClientFilterIds(
  tenantId: string,
  clientId: string | null,
  rollupSubClients: boolean
): Promise<string[] | null> {
  if (!clientId) return null
  if (!rollupSubClients) return [clientId]

  const subClients = await prisma.client.findMany({
    where: { tenantId, parentId: clientId },
    select: { id: true },
  })
  return [clientId, ...subClients.map((c) => c.id)]
}

export type ClientHierarchyInfo = { id: string; name: string; parentId: string | null }

/** Map of every client in the tenant, for rolling sub-customer rows up into their parent. */
export async function getClientHierarchyMap(tenantId: string): Promise<Map<string, ClientHierarchyInfo>> {
  const clients = await prisma.client.findMany({
    where: { tenantId },
    select: { id: true, name: true, companyName: true, parentId: true },
  })
  const map = new Map<string, ClientHierarchyInfo>()
  for (const c of clients) {
    map.set(c.id, { id: c.id, name: c.companyName || c.name, parentId: c.parentId })
  }
  return map
}

/**
 * Given a client's ID and the hierarchy map, returns the ID/name to roll this
 * client's row up under (the top-level parent), or the client's own id/name if
 * it has no parent or rollup is disabled.
 */
export function rollupTarget(
  clientId: string,
  hierarchy: Map<string, ClientHierarchyInfo>,
  rollupSubClients: boolean
): { id: string; name: string } {
  const info = hierarchy.get(clientId)
  if (!info) return { id: clientId, name: clientId }
  if (!rollupSubClients || !info.parentId) return { id: info.id, name: info.name }
  const parent = hierarchy.get(info.parentId)
  return parent ? { id: parent.id, name: parent.name } : { id: info.id, name: info.name }
}

/** Prisma where-fragment matching a job-site address by substring (street/city/state/zip). */
export function jobSiteAddressWhere(term: string) {
  const trimmed = term.trim()
  if (!trimmed) return null
  return {
    type: 'job_site',
    OR: [
      { street: ilike(trimmed) },
      { city: ilike(trimmed) },
      { state: ilike(trimmed) },
      { zipCode: ilike(trimmed) },
    ],
  }
}
