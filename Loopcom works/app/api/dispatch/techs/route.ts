import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'dispatch.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    end.setHours(23, 59, 59, 999)

    // Get users with tech-related roles or all active users
    const techs = await prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
      },
      orderBy: {
        firstName: 'asc',
      },
    })

    const techIds = techs.map((t) => t.id)
    const activeAssignments = await prisma.jobAssignment.findMany({
      where: {
        userId: { in: techIds },
        job: {
          tenantId: user.tenantId,
          status: { notIn: ['COMPLETED', 'CANCELLED'] as any[] },
        },
      },
      select: { userId: true, jobId: true },
    })
    const todayAssignments = await prisma.jobAssignment.findMany({
      where: {
        userId: { in: techIds },
        job: {
          tenantId: user.tenantId,
          scheduledStart: { gte: start, lte: end },
        },
      },
      include: {
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
            status: true,
            scheduledStart: true,
          },
        },
      },
    })
    const workload = new Map<string, number>()
    for (const row of activeAssignments) {
      workload.set(row.userId, (workload.get(row.userId) || 0) + 1)
    }

    // Check availability for each tech.
    const techsWithAvailability = await Promise.all(
      techs.map(async (tech) => {
        const today = new Date()
        const dayOfWeek = today.getDay()

        const availability = await prisma.techAvailability.findFirst({
          where: {
            tenantId: user.tenantId,
            userId: tech.id,
            dayOfWeek,
            isAvailable: true,
          },
        })

        return {
          id: tech.id,
          firstName: tech.firstName,
          lastName: tech.lastName,
          email: tech.email,
          role: tech.role,
          isAvailable: availability !== null,
          workload: workload.get(tech.id) || 0,
          availabilityStatus:
            availability === null ? 'OVERBOOKED' : (workload.get(tech.id) || 0) === 0 ? 'AVAILABLE' : (workload.get(tech.id) || 0) <= 3 ? 'BUSY' : 'OVERBOOKED',
          todaySchedule: todayAssignments
            .filter((a) => a.userId === tech.id)
            .map((a) => ({
              id: a.job.id,
              jobNumber: a.job.jobNumber,
              title: a.job.title,
              status: a.job.status,
              scheduledStart: a.job.scheduledStart?.toISOString() || null,
            })),
        }
      })
    )

    return NextResponse.json({ techs: techsWithAvailability })
  } catch (error) {
    console.error('Dispatch techs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
