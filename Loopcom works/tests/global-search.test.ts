/**
 * Tests for pure scoring helpers — no Prisma, no network.
 * Run with:  npx tsx --test tests/global-search.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchScore,
  computeScore,
  topN,
  expandQuery,
  smartMatch,
  digitsOnly,
  significantTokens,
  queryVariants,
  levenshtein,
} from '../lib/search/scoring'

// ── matchScore ───────────────────────────────────────────────────────────────

test('matchScore: exact match returns 1.0', () => {
  assert.equal(matchScore('acme', 'Acme'), 1.0)
  assert.equal(matchScore('ACME', 'acme'), 1.0)
})

test('matchScore: prefix match returns 0.85', () => {
  assert.equal(matchScore('acme', 'Acme Corp'), 0.85)
})

test('matchScore: substring match returns 0.7', () => {
  assert.equal(matchScore('supply', 'ABC Supply Co'), 0.7)
})

test('matchScore: no match returns 0', () => {
  assert.equal(matchScore('zebra', 'Acme Corp'), 0)
})

test('matchScore: null / undefined returns 0', () => {
  assert.equal(matchScore('foo', null), 0)
  assert.equal(matchScore('foo', undefined), 0)
  assert.equal(matchScore('foo', ''), 0)
})

test('matchScore: phone digits match formatted numbers', () => {
  assert.ok(matchScore('8456628688', '(845) 662-8688') > 0)
  assert.ok(matchScore('662-8688', '+1 845-662-8688') > 0)
})

test('matchScore: light fuzzy typo on short token', () => {
  assert.ok(matchScore('smtih', 'John Smith') > 0)
})

// ── computeScore ─────────────────────────────────────────────────────────────

test('computeScore: primary field match scores higher than secondary', () => {
  const primary = computeScore('roof', ['Roofing Contract'], [], null)
  const secondary = computeScore('roof', [], ['Roofing Contract'], null)
  assert.ok(primary > secondary, `primary(${primary}) should > secondary(${secondary})`)
})

test('computeScore: primary field match scores higher than same term in secondary', () => {
  const inPrimary = computeScore('000228', ['INV-000228'], [], null)
  const inSecondary = computeScore('000228', [], ['note referencing INV-000228'], null)
  assert.ok(inPrimary > inSecondary, `primary(${inPrimary}) should > secondary(${inSecondary})`)
})

test('computeScore: recent record gets recency bonus', () => {
  const recent = computeScore('foo', ['foo'], [], new Date())
  const old = computeScore('foo', ['foo'], [], new Date(2020, 0, 1))
  assert.ok(recent > old, `recent(${recent}) should > old(${old})`)
})

test('computeScore: missing updatedAt has no recency bonus', () => {
  const withBonus = computeScore('x', ['x'], [], new Date())
  const noBonus = computeScore('x', ['x'], [], null)
  assert.ok(withBonus > noBonus)
})

// ── topN ─────────────────────────────────────────────────────────────────────

test('topN: returns top items sorted by score desc', () => {
  const items = [
    { id: 'a', score: 40 },
    { id: 'b', score: 100 },
    { id: 'c', score: 70 },
  ]
  const result = topN(items, 2)
  assert.equal(result.length, 2)
  assert.equal(result[0].id, 'b')
  assert.equal(result[1].id, 'c')
})

test('topN: handles n >= array length', () => {
  const items = [{ id: 'a', score: 10 }]
  assert.equal(topN(items, 100).length, 1)
})

test('topN: handles empty array', () => {
  assert.deepEqual(topN([], 5), [])
})

test('topN: does not mutate original array', () => {
  const items = [{ id: 'a', score: 10 }, { id: 'b', score: 90 }]
  topN(items, 2)
  assert.equal(items[0].id, 'a') // original order preserved
})

// ── expandQuery / queryVariants ──────────────────────────────────────────────

test('expandQuery: vendor expands to include supplier', () => {
  const terms = expandQuery('vendor')
  assert.ok(terms.includes('vendor'))
  assert.ok(terms.includes('supplier'))
})

test('expandQuery: supplier expands to include vendor', () => {
  const terms = expandQuery('supplier')
  assert.ok(terms.includes('supplier'))
  assert.ok(terms.includes('vendor'))
})

test('expandQuery: estimate expands to proposal and quote', () => {
  const terms = expandQuery('estimate')
  assert.ok(terms.includes('proposal'))
  assert.ok(terms.includes('quote'))
})

test('expandQuery: unknown term returns just itself', () => {
  const terms = expandQuery('xylophone123')
  assert.deepEqual(terms, ['xylophone123'])
})

test('expandQuery: trims whitespace', () => {
  const terms = expandQuery('  job  ')
  assert.ok(terms.includes('job'))
})

test('expandQuery: no duplicates in result', () => {
  const terms = expandQuery('estimate')
  const unique = Array.from(new Set(terms))
  assert.deepEqual(terms, unique)
})

test('queryVariants: includes digit form for phone-like input', () => {
  const terms = queryVariants('(845) 662-8688')
  assert.ok(terms.some((t) => t.includes('8456628688')))
})

test('significantTokens: splits multi-word queries', () => {
  assert.deepEqual(significantTokens('John Smith Roof'), ['john', 'smith', 'roof'])
})

test('digitsOnly: strips non-digits', () => {
  assert.equal(digitsOnly('(845) 662-8688'), '8456628688')
})

test('levenshtein: detects single edit', () => {
  assert.equal(levenshtein('smith', 'smtih', 1), 1)
  assert.ok(levenshtein('smith', 'abcdef', 1) > 1)
})

// ── smartMatch ───────────────────────────────────────────────────────────────

test('smartMatch: empty query matches everything', () => {
  assert.equal(smartMatch('', ['Acme']), true)
})

test('smartMatch: multi-word AND across fields', () => {
  assert.equal(smartMatch('john roof', ['John Smith', 'Roofing Job']), true)
  assert.equal(smartMatch('john zebra', ['John Smith', 'Roofing Job']), false)
})

test('smartMatch: phone formatting tolerant', () => {
  assert.equal(smartMatch('845-662', ['Acme', '(845) 662-8688']), true)
})
