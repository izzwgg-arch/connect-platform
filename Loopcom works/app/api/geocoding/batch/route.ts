import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { batchGeocodeAddresses } from '@/lib/geocoding'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { addressIds } = body

    if (!Array.isArray(addressIds) || addressIds.length === 0) {
      return NextResponse.json({ error: 'addressIds array is required' }, { status: 400 })
    }

    // Limit batch size for safety
    const limitedIds = addressIds.slice(0, 100).map((x: unknown) => String(x))

    // Scope to this tenant — batchGeocodeAddresses looks up addresses by raw id
    // with no tenant filter, so without this a caller could pass another
    // tenant's address ids and trigger writes on them (cross-tenant IDOR).
    // Address has no direct tenantId; it belongs to a tenant via its client or job.
    const owned = await prisma.address.findMany({
      where: {
        id: { in: limitedIds },
        OR: [
          { client: { tenantId: user.tenantId } },
          { job: { tenantId: user.tenantId } },
        ],
      },
      select: { id: true },
    })
    const ownedIds = owned.map((a) => a.id)

    const successCount = await batchGeocodeAddresses(ownedIds, 200)

    return NextResponse.json({
      success: true,
      processed: ownedIds.length,
      successCount,
      failed: ownedIds.length - successCount,
    })
  } catch (error) {
    console.error('Batch geocoding error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
