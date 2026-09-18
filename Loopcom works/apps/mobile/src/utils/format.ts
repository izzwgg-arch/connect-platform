/**
 * Format a money amount from a string/number (dollars) as $1,234.56
 */
export function formatMoney(amount?: string | number | null): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const n = typeof amount === 'number' ? amount : Number.parseFloat(String(amount).replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

/** Format cents as dollars */
export function formatCents(cents?: number | null): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  return formatMoney(cents / 100)
}

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatMinutes(minutes?: number | null): string {
  const m = Math.max(0, Math.floor(Number(minutes) || 0))
  const h = Math.floor(m / 60)
  const rem = m % 60
  return `${h}h ${rem}m`
}

export function formatJobType(jobType?: string | null): string {
  if (!jobType) return ''
  return String(jobType).replaceAll('_', ' ')
}

export function formatBillingStatus(status?: string | null): string {
  if (!status) return 'Unbilled'
  const trimmed = String(status).trim()
  if (!trimmed || /^unbilled$/i.test(trimmed)) return 'Unbilled'
  if (/%\s*billed/i.test(trimmed)) return trimmed
  const match = trimmed.match(/(\d+)\s*%/)
  if (match) {
    const percent = Math.max(0, Math.min(100, parseInt(match[1], 10)))
    return percent <= 0 ? 'Unbilled' : `${percent}% billed`
  }
  return trimmed
}
