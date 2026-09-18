/**
 * Pure scoring helpers for global and list search — no Prisma, safe to import in tests.
 */

export interface RawResult {
  id: string
  entityType: string
  title: string
  subtitle: string
  url: string
  score: number
  updatedAt?: Date | null
}

/** Strip to digits only (for phone matching). */
export function digitsOnly(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}

/** Split a query into meaningful tokens (lowercase, de-punctuated). */
export function tokenize(raw: string): string[] {
  return raw
    .trim()
    .toLowerCase()
    .split(/[\s,./\\_|+\-()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Expand a query into search variants used for DB OR clauses and scoring.
 * Includes original, synonym expansions, and digit-only phone forms.
 */
export function queryVariants(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  const terms = new Set<string>()
  for (const base of expandQuery(trimmed)) {
    terms.add(base)
    const digits = digitsOnly(base)
    if (digits.length >= 3) terms.add(digits)
  }

  // Also keep raw trimmed for exact case-insensitive contains
  terms.add(trimmed.toLowerCase())
  return Array.from(terms)
}

/** Tokens to require for multi-word AND search (drops tiny filler tokens). */
export function significantTokens(raw: string): string[] {
  const stop = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'for', 'in', 'on', 'at'])
  const tokens = tokenize(raw).filter((t) => t.length >= 2 && !stop.has(t))
  return tokens.length > 0 ? tokens : tokenize(raw).filter((t) => t.length > 0)
}

/** Damerau–Levenshtein distance (includes adjacent transpositions), capped. */
export function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  if (Math.abs(a.length - b.length) > max) return max + 1

  const da: Record<string, number> = {}
  const maxdist = a.length + b.length
  const d: number[][] = Array.from({ length: a.length + 2 }, () =>
    Array(b.length + 2).fill(0)
  )
  d[0][0] = maxdist
  for (let i = 0; i <= a.length; i++) {
    d[i + 1][0] = maxdist
    d[i + 1][1] = i
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j + 1] = maxdist
    d[1][j + 1] = j
  }

  for (let i = 1; i <= a.length; i++) {
    let db = 0
    let rowMin = max + 1
    for (let j = 1; j <= b.length; j++) {
      const i1 = da[b[j - 1]] || 0
      const j1 = db
      let cost = 1
      if (a[i - 1] === b[j - 1]) {
        cost = 0
        db = j
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost,
        d[i + 1][j] + 1,
        d[i][j + 1] + 1,
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)
      )
      if (d[i + 1][j + 1] < rowMin) rowMin = d[i + 1][j + 1]
    }
    da[a[i - 1]] = i
    if (rowMin > max) return max + 1
  }

  return d[a.length + 1][b.length + 1]
}

/**
 * Score how well `value` matches `query`.
 * Returns 0–1:
 *   1.0 exact  0.9 phone digits exact  0.85 prefix
 *   0.75 fuzzy token  0.7 contains  0.55 token all-match  0 = no match
 */
export function matchScore(query: string, value: string | null | undefined): number {
  if (!value) return 0
  const lv = value.toLowerCase()
  const lq = query.trim().toLowerCase()
  if (!lq) return 0
  if (lv === lq) return 1.0
  if (lv.startsWith(lq)) return 0.85
  if (lv.includes(lq)) return 0.7

  const qDigits = digitsOnly(lq)
  const vDigits = digitsOnly(lv)
  if (qDigits.length >= 3 && vDigits.includes(qDigits)) {
    return vDigits === qDigits || vDigits.endsWith(qDigits) ? 0.9 : 0.75
  }

  const tokens = significantTokens(lq)
  if (tokens.length > 1) {
    const allFound = tokens.every(
      (t) => lv.includes(t) || (digitsOnly(t).length >= 3 && vDigits.includes(digitsOnly(t)))
    )
    if (allFound) return 0.55
  }

  // Light fuzzy: single short token with 1 edit against a word in value
  if (tokens.length === 1) {
    const token = tokens[0]
    if (token.length >= 3 && token.length <= 12) {
      const words = tokenize(lv)
      for (const word of words) {
        if (word.length < 2) continue
        const dist = levenshtein(token, word, 1)
        if (dist === 1) return 0.75
        if (word.startsWith(token) || token.startsWith(word)) return 0.8
      }
    }
  }

  return 0
}

/**
 * Client-side haystack filter: true if query smart-matches any field.
 * Multi-token queries require every token to match somewhere across fields.
 */
export function smartMatch(
  query: string,
  fields: Array<string | null | undefined>
): boolean {
  const q = query.trim()
  if (!q) return true

  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .join(' \u0001 ')
  if (!haystack) return false

  // Full-query score first
  if (matchScore(q, haystack) > 0) return true

  const tokens = significantTokens(q)
  if (tokens.length <= 1) {
    // fuzzy already attempted in matchScore; check digits across fields
    const qDigits = digitsOnly(q)
    if (qDigits.length >= 3) {
      return fields.some((f) => digitsOnly(f).includes(qDigits))
    }
    return false
  }

  // Every token must match at least one field (AND semantics)
  return tokens.every((token) =>
    fields.some((field) => {
      if (!field) return false
      const lf = field.toLowerCase()
      if (lf.includes(token)) return true
      const td = digitsOnly(token)
      if (td.length >= 3 && digitsOnly(field).includes(td)) return true
      if (token.length >= 3) {
        return tokenize(lf).some((word) => levenshtein(token, word, 1) <= 1)
      }
      return false
    })
  )
}

/**
 * Rank items for client-side pickers/lists. Higher score = better match.
 */
export function scoreHaystack(
  query: string,
  primaryFields: Array<string | null | undefined>,
  secondaryFields: Array<string | null | undefined> = []
): number {
  return computeScore(query, primaryFields, secondaryFields, null)
}

/**
 * Compute a composite relevance score for a result row.
 * Primary fields (names, numbers) are weighted 100; secondary (notes, desc) 40.
 * Recent records get a small bonus.
 */
export function computeScore(
  query: string,
  primaryFields: (string | null | undefined)[],
  secondaryFields: (string | null | undefined)[],
  updatedAt?: Date | null
): number {
  const variants = queryVariants(query)
  let primary = 0
  for (const term of variants) {
    for (const v of primaryFields) {
      primary = Math.max(primary, matchScore(term, v) * 100)
    }
  }

  let secondary = 0
  for (const term of variants) {
    for (const v of secondaryFields) {
      secondary = Math.max(secondary, matchScore(term, v) * 40)
    }
  }

  // Multi-token bonus when all tokens appear across primary fields
  const tokens = significantTokens(query)
  if (tokens.length > 1) {
    const joined = primaryFields.filter(Boolean).join(' ').toLowerCase()
    const allInPrimary = tokens.every((t) => joined.includes(t))
    if (allInPrimary) primary = Math.max(primary, 60)
  }

  let recency = 0
  if (updatedAt) {
    const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000
    if (days < 7) recency = 15
    else if (days < 30) recency = 10
    else if (days < 90) recency = 5
  }

  return Math.round(primary + secondary + recency)
}

/** Sort results by score desc and take the top N. */
export function topN<T extends { score: number }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => b.score - a.score).slice(0, n)
}

/**
 * Expand the user's raw query into additional search terms via a synonym map.
 * Returns all distinct terms to use (including the original).
 */
const SYNONYM_MAP: Record<string, string[]> = {
  customer: ['client'],
  client: ['customer'],
  vendor: ['supplier'],
  supplier: ['vendor'],
  estimate: ['proposal', 'quote'],
  proposal: ['estimate', 'quote'],
  quote: ['estimate', 'proposal'],
  po: ['purchase order', 'purchaseorder'],
  'purchase order': ['po'],
  purchaseorder: ['po'],
  file: ['attachment', 'document', 'pdf'],
  attachment: ['file', 'document'],
  document: ['file', 'attachment', 'pdf'],
  pdf: ['file', 'document', 'attachment'],
  paid: ['payment', 'completed'],
  payment: ['paid'],
  partial: ['deposit', 'partial payment'],
  deposit: ['partial', 'partial payment'],
  job: ['project', 'work order'],
  project: ['job'],
  task: ['reminder', 'to-do', 'todo'],
  reminder: ['task'],
  todo: ['task'],
  note: ['comment'],
  comment: ['note'],
  issue: ['ticket', 'problem'],
  ticket: ['issue'],
  request: ['lead'],
  lead: ['request'],
}

export function expandQuery(raw: string): string[] {
  const q = raw.trim().toLowerCase()
  if (!q) return []
  const synonyms = SYNONYM_MAP[q] ?? []
  // Also expand individual tokens for multi-word synonym hits
  const tokenSynonyms = tokenize(q).flatMap((t) => SYNONYM_MAP[t] ?? [])
  return Array.from(new Set([q, ...synonyms, ...tokenSynonyms]))
}
