import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'clients.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const content = String(body?.content || '').trim()

    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: {
        id: true,
        name: true,
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const note = await prisma.note.create({
      data: {
        clientId: client.id,
        content,
        createdById: user.id,
      },
    })

    return NextResponse.json(
      {
        note: {
          id: note.id,
          content: note.content,
          createdAt: note.createdAt.toISOString(),
          authorName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create client note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
