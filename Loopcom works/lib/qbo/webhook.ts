import crypto from 'crypto'

export function verifyIntuitWebhookSignature(params: {
  rawBody: string
  signatureHeader: string | null
  verifierToken: string | undefined
}): boolean {
  if (!params.verifierToken) return false
  if (!params.signatureHeader) return false

  const expected = crypto
    .createHmac('sha256', params.verifierToken)
    .update(params.rawBody, 'utf8')
    .digest('base64')

  // Intuit sends base64 signature in `intuit-signature`.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signatureHeader))
  } catch {
    return false
  }
}

export function hashPayload(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex')
}

