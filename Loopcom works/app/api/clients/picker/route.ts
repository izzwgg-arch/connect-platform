import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { CLIENT_PICKER_PERMISSIONS } from '@/lib/clients/client-picker-access'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

/**
 * GET /api/clients/picker
 * Minimal client list for dropdowns on estimate/invoice/job forms.
 */
export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, [...CLIENT_PICKER_PERMISSIONS])
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(5000, Math.max(1, parseInt(searchParams.get('limit') || '5000', 10)))
  const skip = (page - 1) * limit

  try {
    const where: {
      tenantId: string
      isActive?: boolean
      OR?: Array<Record<string, unknown>>
    } = {
      tenantId: user.tenantId,
      isActive: true,
    }

    applySmartSearch(
      where as any,
      buildSmartSearchAnd(search, (term) => [
        { name: ilike(term) },
        { companyName: ilike(term) },
        { email: ilike(term) },
        { phone: ilike(term) },
        {
          addresses: {
            some: {
              OR: [
                { street: ilike(term) },
                { city: ilike(term) },
                { state: ilike(term) },
                { zipCode: ilike(term) },
              ],
            },
          },
        },
        {
          contacts: {
            some: {
              OR: [
                { firstName: ilike(term) },
                { lastName: ilike(term) },
                { email: ilike(term) },
                { phone: ilike(term) },
              ],
            },
          },
        },
      ])
    )

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        select: {
          id: true,
          name: true,
          companyName: true,
          email: true,
          phone: true,
        },
        orderBy: [{ name: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.client.count({ where }),
    ])

    return NextResponse.json({
      clients,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    console.error('Get clients picker error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
