type RecipientInput = string | string[] | null | undefined

export function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase()
}

export function normalizeRecipients(input: RecipientInput): string[] {
  const raw = Array.isArray(input) ? input : input ? [input] : []
  const seen = new Set<string>()
  const recipients: string[] = []

  for (const value of raw) {
    const normalized = normalizeEmail(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    recipients.push(normalized)
  }

  return recipients
}

export function parseEmailList(input: RecipientInput): string[] {
  const raw = Array.isArray(input)
    ? input.flatMap((value) => String(value || '').split(/[,\s;]+/g))
    : input
      ? String(input).split(/[,\s;]+/g)
      : []

  return normalizeRecipients(raw)
}

export function dedupeRecipients(recipients: {
  to: RecipientInput
  cc?: RecipientInput
  bcc?: RecipientInput
}): {
  to: string[]
  cc: string[]
  bcc: string[]
} {
  const to = parseEmailList(recipients.to)
  const toSet = new Set(to)
  const cc = parseEmailList(recipients.cc).filter((email) => !toSet.has(email))
  const ccSet = new Set(cc)
  const bcc = parseEmailList(recipients.bcc).filter((email) => !toSet.has(email) && !ccSet.has(email))

  return { to, cc, bcc }
}

export function getConfiguredGlobalCcRecipients(): string[] {
  return parseEmailList(process.env.ADMIN_CC_EMAIL || 'Trimpronyinc@gmail.com')
}

export function mergeConfiguredGlobalCc(input: {
  to: RecipientInput
  cc?: RecipientInput
  bcc?: RecipientInput
  skipGlobalCc?: boolean
}): { to: string[]; cc: string[]; bcc: string[]; globalCc: string[] } {
  const globalCc = input.skipGlobalCc ? [] : getConfiguredGlobalCcRecipients()
  const to = parseEmailList(input.to)
  const toSet = new Set(to)
  const cc = normalizeRecipients([...(parseEmailList(input.cc)), ...globalCc]).filter(
    (email) => !toSet.has(email)
  )
  const ccSet = new Set(cc)
  const bcc = parseEmailList(input.bcc).filter((email) => !toSet.has(email) && !ccSet.has(email))

  return { to, cc, bcc, globalCc }
}

