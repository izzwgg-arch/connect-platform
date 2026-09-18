const SCRIPT_TAG_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi
const EVENT_HANDLER_ATTR_REGEX = /\son[a-z]+\s*=\s*(['"]).*?\1/gi
const JS_URL_REGEX = /javascript:/gi

export function sanitizeOptionalHtmlBlock(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = String(input).trim()
  if (!trimmed) return null

  return trimmed
    .replace(SCRIPT_TAG_REGEX, '')
    .replace(EVENT_HANDLER_ATTR_REGEX, '')
    .replace(JS_URL_REGEX, '')
}
