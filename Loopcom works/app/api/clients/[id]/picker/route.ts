import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { CLIENT_PICKER_PERMISSIONS } from '@/lib/clients/client-picker-access'

/**
 * GET /api/clients/[id]/picker
 * Minimal client detail for form prefills (addresses/contacts) without clients.view.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, [...CLIENT_PICKER_PERMISSIONS])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        name: true,
        companyName: true,
        email: true,
        phone: true,
        addresses: {
          orderBy: [{ isDefault: 'desc' }],
          select: {
            id: true,
            type: true,
            street: true,
            city: true,
            state: true,
            zipCode: true,
            country: true,
            isDefault: true,
          },
        },
        contacts: {
          orderBy: [{ isPrimary: 'desc' }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            mobile: true,
            isPrimary: true,
          },
        },
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json({ client })
  } catch (error) {
    console.error('Get client picker detail error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
