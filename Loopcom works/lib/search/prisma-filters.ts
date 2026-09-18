/**
 * Shared Prisma search clause builders for list APIs.
 * Multi-token queries become AND-of-OR (every token must match somewhere).
 */

import { digitsOnly, queryVariants, significantTokens } from './scoring'

export function ilike(search: string) {
  return { contains: search, mode: 'insensitive' as const }
}

type Clause = Record<string, unknown>

/**
 * Build a where fragment for a search string.
 * - Single token / phone: OR over field clauses for each query variant
 * - Multi-token: AND of (OR over field clauses for each token)
 *
 * `fieldClausesFor` receives one term and returns Prisma OR clauses for that term.
 */
export function buildSmartSearchAnd(
  raw: string,
  fieldClausesFor: (term: string) => Clause[]
): Clause | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const tokens = significantTokens(trimmed)

  // Phone-like: prefer digit variants alongside text variants
  if (tokens.length <= 1) {
    const variants = queryVariants(trimmed)
    const or: Clause[] = []
    for (const term of variants) {
      or.push(...fieldClausesFor(term))
      const digits = digitsOnly(term)
      if (digits.length >= 3 && digits !== term) {
        or.push(...fieldClausesFor(digits))
      }
    }
    // Deduplicate by JSON stringify (clauses are small)
    const seen = new Set<string>()
    const unique = or.filter((c) => {
      const key = JSON.stringify(c)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return unique.length ? { OR: unique } : null
  }

  // Multi-word: every significant token must match at least one field
  return {
    AND: tokens.map((token) => {
      const variants = queryVariants(token)
      const or: Clause[] = []
      for (const term of variants) {
        or.push(...fieldClausesFor(term))
      }
      const seen = new Set<string>()
      const unique = or.filter((c) => {
        const key = JSON.stringify(c)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return { OR: unique }
    }),
  }
}

/** Merge a smart-search clause into an existing Prisma where (uses AND). */
export function applySmartSearch(where: Record<string, any>, searchClause: Clause | null) {
  if (!searchClause) return where
  where.AND = where.AND || []
  where.AND.push(searchClause)
  return where
}

/** Common client name/company/email/phone OR clauses. */
export function clientIdentityClauses(term: string, relation = 'client'): Clause[] {
  return [
    { [relation]: { name: ilike(term) } },
    { [relation]: { companyName: ilike(term) } },
    { [relation]: { email: ilike(term) } },
    { [relation]: { phone: ilike(term) } },
  ]
}

/** Common contact name/email/phone OR clauses under a client relation. */
export function clientContactClauses(term: string, relation = 'client'): Clause[] {
  return [
    {
      [relation]: {
        contacts: {
          some: {
            OR: [
              { firstName: ilike(term) },
              { lastName: ilike(term) },
              { email: ilike(term) },
              { phone: ilike(term) },
            ],
          },
        },
      },
    },
  ]
}
