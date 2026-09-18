import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

/**
 * Mobile API: Update user location (for tracking)
 * Optional: Can be used for real-time dispatch tracking
 */
export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { latitude, longitude, accuracy, timestamp } = body

    if (latitude === undefined || longitude === undefined) {
      return NextResponse.json({ error: 'Latitude and longitude are required' }, { status: 400 })
    }

    // Store location in user metadata or separate location tracking table
    // For now, we'll just acknowledge receipt
    // In production, you might want to store this in a LocationTracking table

    return NextResponse.json({
      success: true,
      message: 'Location received',
      timestamp: timestamp || new Date().toISOString(),
    })
  } catch (error) {
    console.error('Mobile location error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
