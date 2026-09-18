/**
 * Inline calculator for numeric line-item fields (price, cost, qty, tax %).
 *
 * - Number first, then operators (e.g. 100+50, 25*4) → Enter evaluates to the total.
 * - Operator/symbol first (e.g. +10, -5, *2) → leave unchanged (current behavior).
 * - Plain numbers with no operator → leave unchanged.
 */

const CALC_CHARSET = /^[0-9.+\-*/()\s]+$/

/** True when the value starts with a digit/decimal (calculator mode eligible). */
export function startsWithNumber(raw: string): boolean {
  const s = String(raw || '').trim()
  // Leading "(" is allowed for grouped expressions like (10+5)*2.
  return /^[0-9.(]/.test(s)
}

/**
 * Evaluate a calculator expression.
 * Returns a formatted number string, or null if it should not be evaluated.
 */
export function tryEvaluateCalculatorExpression(raw: string): string | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null

  // Operator/symbol before the amount (+10, -5, *2, /2) → keep today's behavior.
  if (/^[+\-*/]/.test(trimmed)) return null
  if (!startsWithNumber(trimmed)) return null

  const compact = trimmed.replace(/\s+/g, '')
  if (!CALC_CHARSET.test(compact)) return null

  // Need at least one operator after the leading number (not a plain number / signed value).
  if (!hasInfixOperator(compact)) return null

  try {
    const result = evaluateArithmetic(compact)
    if (!Number.isFinite(result)) return null
    return formatCalculatorResult(result)
  } catch {
    return null
  }
}

function hasInfixOperator(expr: string): boolean {
  // Skip leading number (digits/dots), then look for + - * /
  let i = 0
  while (i < expr.length && /[0-9.]/.test(expr[i])) i += 1
  for (; i < expr.length; i += 1) {
    const ch = expr[i]
    if (ch === '+' || ch === '*' || ch === '/') return true
    // Unary minus after an operator is fine; binary minus is an infix op.
    if (ch === '-') {
      const prev = expr[i - 1]
      if (prev && /[0-9.)]/.test(prev)) return true
    }
  }
  return false
}

function formatCalculatorResult(n: number): string {
  // Keep up to 4 decimals, strip trailing zeros.
  const fixed = Math.round(n * 10000) / 10000
  if (Number.isInteger(fixed)) return String(fixed)
  return String(fixed)
}

/**
 * Safe arithmetic evaluator for + - * / and parentheses.
 * Supports unary minus. No variables, no function calls.
 */
function evaluateArithmetic(expr: string): number {
  let i = 0

  const peek = () => expr[i]
  const consume = () => {
    const ch = expr[i]
    i += 1
    return ch
  }

  const parseNumber = (): number => {
    let start = i
    while (i < expr.length && /[0-9.]/.test(expr[i])) i += 1
    const raw = expr.slice(start, i)
    if (!raw || raw === '.' || (raw.match(/\./g) || []).length > 1) {
      throw new Error('bad number')
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error('bad number')
    return n
  }

  const parseFactor = (): number => {
    if (peek() === '+') {
      consume()
      return parseFactor()
    }
    if (peek() === '-') {
      consume()
      return -parseFactor()
    }
    if (peek() === '(') {
      consume()
      const v = parseExpression()
      if (peek() !== ')') throw new Error('missing )')
      consume()
      return v
    }
    if (peek() && /[0-9.]/.test(peek())) return parseNumber()
    throw new Error('unexpected')
  }

  const parseTerm = (): number => {
    let v = parseFactor()
    while (peek() === '*' || peek() === '/') {
      const op = consume()
      const r = parseFactor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }

  const parseExpression = (): number => {
    let v = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = consume()
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  const value = parseExpression()
  if (i !== expr.length) throw new Error('trailing')
  return value
}

/**
 * Handle Enter in a calculator-enabled input.
 * Returns true if the event was handled (caller should skip further defaults).
 */
export function handleCalculatorEnterKey(
  event: { key: string; preventDefault: () => void },
  value: string,
  commit: (next: string) => void
): boolean {
  if (event.key !== 'Enter') return false
  event.preventDefault()
  const next = tryEvaluateCalculatorExpression(value)
  if (next != null && next !== String(value).trim()) {
    commit(next)
  }
  return true
}
