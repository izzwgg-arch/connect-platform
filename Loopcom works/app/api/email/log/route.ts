import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const status = searchParams.get('status')
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
      direction: 'OUTBOUND',
    }

    if (status && status !== 'all') {
      where.status = status
    }

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          client: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.email.count({ where }),
    ])

    return NextResponse.json({
      emails: emails.map((email) => ({
        id: email.id,
        to: email.toEmails.join(', '),
        subject: email.subject,
        status: email.status,
        createdAt: email.createdAt.toISOString(),
        sentAt: email.sentAt?.toISOString() || null,
        user: email.user ? `${email.user.firstName} ${email.user.lastName}` : null,
        client: email.client?.name || null,
        providerId: email.providerId,
        error: (email.providerData as any)?.error || null,
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get email log error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
