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
  const direction = searchParams.get('direction') || 'all'
  const clientId = searchParams.get('clientId') || ''
  const conversation = searchParams.get('conversation') // phone number for conversation view
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    if (direction !== 'all') {
      where.direction = direction
    }

    if (clientId) {
      where.clientId = clientId
    }

    // Conversation view - get messages between two numbers
    if (conversation) {
      where.OR = [
        { fromNumber: conversation, toNumber: process.env.VOIPMS_DID || '' },
        { fromNumber: process.env.VOIPMS_DID || '', toNumber: conversation },
      ]
    }

    const [smsMessages, total] = await Promise.all([
      prisma.smsMessage.findMany({
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
          contact: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          job: {
            select: {
              id: true,
              jobNumber: true,
            },
          },
        },
        orderBy: {
          sentAt: 'desc',
        },
        skip,
        take: limit,
      }),
      prisma.smsMessage.count({ where }),
    ])

    // Group by conversation for conversation view
    if (conversation) {
      const conversations = new Map<string, any[]>()
      
      for (const sms of smsMessages) {
        const convKey = sms.fromNumber === conversation ? sms.toNumber : sms.fromNumber
        if (!conversations.has(convKey)) {
          conversations.set(convKey, [])
        }
        conversations.get(convKey)!.push(sms)
      }

      return NextResponse.json({
        conversations: Array.from(conversations.entries()).map(([number, messages]) => ({
          number,
          messages: messages.sort((a, b) => new Date(a.sentAt || 0).getTime() - new Date(b.sentAt || 0).getTime()),
          unread: messages.filter((m) => m.direction === 'INBOUND' && m.status === 'DELIVERED').length,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    }

    return NextResponse.json({
      smsMessages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get SMS error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
