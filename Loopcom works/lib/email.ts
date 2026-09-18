export function splitEmailList(value: string | null | undefined): string[] {
  if (!value) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function normalizeEmailList(value: string | null | undefined): string | null {
  const emails = splitEmailList(value)
  if (!emails.length) return null

  // De-dupe case-insensitively but keep original casing for display.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const e of emails) {
    const key = e.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(e)
  }

  return unique.join(', ')
}

export function getPrimaryEmail(value: string | null | undefined): string | null {
  const emails = splitEmailList(value)
  return emails[0] || null
}

export function isValidEmail(value: string): boolean {
  // Not perfect, but good enough for UI/API validation here.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
}

