import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { hasMobilePermission, hasPermission, requireAnyPermission } from '@/lib/authorization'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['schedule.view', 'schedule.view_all'])
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const canViewTeamScheduleScope =
      user.role === 'ADMIN' ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.schedule.view_all')) ||
      (await hasMobilePermission(user.id, user.tenantId, 'canCreateSchedulesForOthers')) ||
      (await hasMobilePermission(user.id, user.tenantId, 'mobile.jobs.assign')) ||
      (await hasPermission(user.id, user.tenantId, 'schedule.view_all'))

    // Show active users and invited users so admins can track invite progress.
    const teamMembers = await prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        ...(canViewTeamScheduleScope ? {} : { id: user.id }),
        status: {
          in: ['ACTIVE', 'INVITED'],
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        allowWebLogin: true,
        allowMobileLogin: true,
        assignedJobTypes: true,
        managerId: true,
        manager: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
        userRoles: {
          where: {
            role: {
              isActive: true,
            },
          },
          orderBy: {
            assignedAt: 'desc',
          },
          take: 1,
          select: {
            roleId: true,
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        status: true,
        _count: {
          select: {
            schedules: true,
          },
        },
      },
      orderBy: [
        { firstName: 'asc' },
        { lastName: 'asc' },
      ],
    })

    const normalizedTeamMembers = teamMembers.map((member) => {
      if (member.role !== 'FIELD') {
        return {
          ...member,
          roleId: member.userRoles[0]?.roleId || null,
          roleName: member.userRoles[0]?.role?.name || member.role,
          managerId: null,
          manager: null,
        }
      }
      if (!member.manager || member.manager.role !== 'MANAGER') {
        return {
          ...member,
          roleId: member.userRoles[0]?.roleId || null,
          roleName: member.userRoles[0]?.role?.name || member.role,
          managerId: null,
          manager: null,
        }
      }
      return {
        ...member,
        roleId: member.userRoles[0]?.roleId || null,
        roleName: member.userRoles[0]?.role?.name || member.role,
      }
    })

    return NextResponse.json({ teamMembers: normalizedTeamMembers })
  } catch (error) {
    console.error('Get team error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
