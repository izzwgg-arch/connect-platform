/**
 * Shared phone-number normalization utilities.
 *
 * All phone numbers in the Conversation/Message tables are stored in E.164
 * format (+1XXXXXXXXXX for NANP) so the same number in any display format
 * always maps to a single thread.
 *
 * Examples:
 *   "845-782-1617"       → "+18457821617"
 *   "(845) 782-1617"     → "+18457821617"
 *   "+1 845-782-1617"    → "+18457821617"
 *   "8457821617"         → "+18457821617"
 *   "18457821617"        → "+18457821617"
 */

/** Normalize any phone-number string to E.164 (+1XXXXXXXXXX for NANP). */
export function toE164(input: string): string {
  if (!input) return ''
  const digits = input.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  // International numbers with country code already present
  if (digits.length > 11) return `+${digits}`
  // Best-effort for short/malformed inputs
  return `+1${digits}`
}

/** Return true when two phone strings resolve to the same E.164 number. */
export function samePhone(a: string, b: string): boolean {
  return toE164(a) === toE164(b)
}

/**
 * Format an E.164 (or any) phone number for human display.
 * +18457821617 → (845) 782-1617
 */
export function formatPhone(input: string): string {
  const digits = input.replace(/\D/g, '')
  const num =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits
  if (num.length === 10) {
    return `(${num.slice(0, 3)}) ${num.slice(3, 6)}-${num.slice(6)}`
  }
  return input // return original if format is unknown
}

/**
 * Legacy 10-digit normalizer used by existing code.
 * Strips country code and returns bare 10 digits.
 * Kept for backward-compat; prefer toE164() for new code.
 */
export function toNanp10(input: string): string {
  const digits = input.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}
