import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

/**
 * Returns the Google Maps browser API key for authenticated users.
 *
 * This is used as a runtime fallback when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
 * wasn't inlined at build time (for example if only GOOGLE_MAPS_API_KEY is set).
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.view')
  if (permError) return permError

  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '').trim()
  if (!apiKey) {
    return NextResponse.json({ error: 'Google Maps API key not configured' }, { status: 404 })
  }

  return NextResponse.json({ apiKey })
}

