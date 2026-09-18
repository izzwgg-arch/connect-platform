import { NextRequest, NextResponse } from 'next/server'

type RecaptchaVerifyResponse = {
  success: boolean
  score?: number
  action?: string
  challenge_ts?: string
  hostname?: string
  'error-codes'?: string[]
}

function getClientIp(request: NextRequest): string | undefined {
  const xf = request.headers.get('x-forwarded-for')
  if (xf) return xf.split(',')[0].trim()
  const xr = request.headers.get('x-real-ip')
  if (xr) return xr.trim()
  return undefined
}

function minScore(): number {
  const raw = process.env.RECAPTCHA_MIN_SCORE
  // 0.3 is a common floor for public payment flows that also require a payment-link token.
  const n = raw ? Number(raw) : 0.3
  return Number.isFinite(n) ? n : 0.3
}

/**
 * Enforce reCAPTCHA v3 for public payment actions (fraud prevention requirement).
 *
 * Env vars:
 * - NEXT_PUBLIC_RECAPTCHA_SITE_KEY (client)
 * - RECAPTCHA_SECRET_KEY (server)
 */
export async function requireRecaptchaV3(params: {
  request: NextRequest
  token: string | null | undefined
  expectedAction: string
}): Promise<NextResponse | null> {
  const secret = process.env.RECAPTCHA_SECRET_KEY
  const isProd = process.env.NODE_ENV === 'production'

  if (!isProd && String(params.token || '').trim() === 'dev-bypass') {
    return null
  }

  if (!secret) {
    // In production we must have it configured (Intuit requirement for Payments/Money Movement).
    if (isProd) {
      return NextResponse.json(
        { error: 'reCAPTCHA is not configured (missing RECAPTCHA_SECRET_KEY).' },
        { status: 500 }
      )
    }
    // In dev, allow.
    return null
  }

  const token = String(params.token || '').trim()
  if (!token) {
    return NextResponse.json({ error: 'reCAPTCHA required' }, { status: 403 })
  }

  const ip = getClientIp(params.request)
  const body = new URLSearchParams({
    secret,
    response: token,
  })
  if (ip) body.set('remoteip', ip)

  const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  const data = (await resp.json().catch(() => null)) as RecaptchaVerifyResponse | null
  if (!data?.success) {
    const errorCodes = data?.['error-codes'] || []
    const errorMsg = errorCodes.length > 0 
      ? `reCAPTCHA verification failed: ${errorCodes.join(', ')}`
      : 'reCAPTCHA verification failed'
    console.error('[reCAPTCHA] Verification failed:', { errorCodes, action: params.expectedAction, hasToken: !!token })
    return NextResponse.json(
      { error: errorMsg, codes: errorCodes },
      { status: 403 }
    )
  }

  if (data.action && data.action !== params.expectedAction) {
    return NextResponse.json({ error: 'reCAPTCHA action mismatch' }, { status: 403 })
  }

  const score = typeof data.score === 'number' ? data.score : 0
  const threshold = minScore()
  if (score < threshold) {
    console.warn('[reCAPTCHA] Score below threshold:', {
      score,
      threshold,
      action: data.action || params.expectedAction,
      hostname: data.hostname,
      ip,
    })
    return NextResponse.json({ error: 'reCAPTCHA score too low' }, { status: 403 })
  }

  return null
}

