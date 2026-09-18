import { NextResponse } from 'next/server'

/**
 * Public endpoint: returns the reCAPTCHA v3 site key.
 * Site keys are not secret; this endpoint is used as a runtime fallback when
 * NEXT_PUBLIC_* env vars were not present at build time.
 */
export async function GET() {
  const key =
    process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ||
    process.env.RECAPTCHA_SITE_KEY ||
    ''

  return NextResponse.json({ siteKey: String(key || '') })
}

