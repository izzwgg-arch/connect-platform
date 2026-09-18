import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

const assignSchema = z.object({
  userId: z.string().min(1),
  integrationId: z.string().min(1).nullable(),
})

function isAdmin(user: { role?: string }) {
  return String(user.role || '') === 'ADMIN'
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const [users, integrations, assignments] = await Promise.all([
    db.user.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
      },
    }),
    db.emailIntegration.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      orderBy: { displayName: 'asc' },
      select: {
        id: true,
        displayName: true,
        fromEmail: true,
        status: true,
      },
    }),
    db.userEmailIntegrationAssignment.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      select: {
        userId: true,
        integrationId: true,
      },
    }),
  ])

  const assignmentByUser = new Map(
    assignments.map((a: { userId: string; integrationId: string }) => [a.userId, a.integrationId])
  )

  return NextResponse.json({
    users: users.map((u: any) => ({
      ...u,
      fullName: `${u.firstName} ${u.lastName}`.trim(),
      integrationId: assignmentByUser.get(u.id) || null,
    })),
    integrations,
  })
}

export async function PUT(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const parsed = assignSchema.parse(body)

    const db = prisma as any
    const targetUser = await db.user.findFirst({
      where: { id: parsed.userId, tenantId: user.tenantId },
      select: { id: true },
    })
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (!parsed.integrationId) {
      await db.userEmailIntegrationAssignment.deleteMany({
        where: { tenantId: user.tenantId, userId: parsed.userId },
      })
      return NextResponse.json({ success: true, integrationId: null })
    }

    const integration = await db.emailIntegration.findFirst({
      where: {
        id: parsed.integrationId,
        tenantId: user.tenantId,
        isActive: true,
      },
      select: { id: true },
    })
    if (!integration) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    }

    const assignment = await db.userEmailIntegrationAssignment.upsert({
      where: {
        tenantId_userId: {
          tenantId: user.tenantId,
          userId: parsed.userId,
        },
      },
      create: {
        tenantId: user.tenantId,
        userId: parsed.userId,
        integrationId: parsed.integrationId,
        assignedById: user.id,
        updatedById: user.id,
        isActive: true,
      },
      update: {
        integrationId: parsed.integrationId,
        updatedById: user.id,
        isActive: true,
      },
    })

    return NextResponse.json({ success: true, assignmentId: assignment.id, integrationId: assignment.integrationId })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    console.error('Update email integration assignment error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
