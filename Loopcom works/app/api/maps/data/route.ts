import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams

  const dateRange = searchParams.get('dateRange') || 'today' // today, week, custom
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const showJobs = searchParams.get('showJobs') !== 'false'
  const showClients = searchParams.get('showClients') === 'true'
  const showTechs = searchParams.get('showTechs') === 'true'
  const statusFilter = searchParams.get('status')
  const techId = searchParams.get('techId')
  const priorityFilter = searchParams.get('priority')

  try {
    // Calculate date range
    let dateFilter: { gte?: Date; lte?: Date } | undefined
    if (dateRange === 'today') {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      dateFilter = { gte: today, lte: tomorrow }
    } else if (dateRange === 'week') {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 7)
      dateFilter = { gte: start, lte: end }
    } else if (startDate && endDate) {
      dateFilter = { gte: new Date(startDate), lte: new Date(endDate) }
    }

    const data: {
      jobs: any[]
      clients: any[]
      techs: any[]
    } = {
      jobs: [],
      clients: [],
      techs: [],
    }

    // Fetch jobs with addresses
    if (showJobs) {
      const where: any = {
        tenantId: user.tenantId,
        addresses: {
          some: {
            latitude: { not: null },
            longitude: { not: null },
          },
        },
      }

      if (dateFilter) {
        where.OR = [
          { scheduledStart: dateFilter },
          { scheduledEnd: dateFilter },
          { createdAt: dateFilter },
        ]
      }

      if (statusFilter && statusFilter !== 'all') {
        where.status = statusFilter
      }

      if (priorityFilter && priorityFilter !== 'all') {
        where.priority = parseInt(priorityFilter)
      }

      if (techId) {
        where.assignments = {
          some: {
            userId: techId,
          },
        }
      }

      const jobs = await prisma.job.findMany({
        where,
        include: {
          client: {
            select: {
              id: true,
              name: true,
              companyName: true,
            },
          },
          addresses: {
            where: {
              latitude: { not: null },
              longitude: { not: null },
            },
            take: 1, // Use first geocoded address
          },
          assignments: {
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
        take: 500, // Limit for performance
      })

      data.jobs = jobs
        .filter((job) => job.addresses.length > 0)
        .map((job) => ({
          id: job.id,
          jobNumber: job.jobNumber,
          title: job.title,
          status: job.status,
          priority: job.priority,
          scheduledStart: job.scheduledStart?.toISOString() || null,
          scheduledEnd: job.scheduledEnd?.toISOString() || null,
          latitude: job.addresses[0].latitude,
          longitude: job.addresses[0].longitude,
          address: {
            street: job.addresses[0].street,
            city: job.addresses[0].city,
            state: job.addresses[0].state,
            zipCode: job.addresses[0].zipCode,
          },
          client: job.client,
          assignedTechs: job.assignments.map((a) => ({
            id: a.user.id,
            name: `${a.user.firstName} ${a.user.lastName}`,
          })),
        }))
    }

    // Fetch clients with addresses (optional)
    if (showClients) {
      const clients = await prisma.client.findMany({
        where: {
          tenantId: user.tenantId,
          addresses: {
            some: {
              latitude: { not: null },
              longitude: { not: null },
            },
          },
        },
        include: {
          addresses: {
            where: {
              latitude: { not: null },
              longitude: { not: null },
            },
            take: 1,
          },
        },
        take: 200,
      })

      data.clients = clients
        .filter((client) => client.addresses.length > 0)
        .map((client) => ({
          id: client.id,
          name: client.name,
          companyName: client.companyName,
          latitude: client.addresses[0].latitude,
          longitude: client.addresses[0].longitude,
          address: {
            street: client.addresses[0].street,
            city: client.addresses[0].city,
            state: client.addresses[0].state,
            zipCode: client.addresses[0].zipCode,
          },
        }))
    }

    // Fetch technicians (simplified - could add location tracking later)
    if (showTechs) {
      const techs = await prisma.user.findMany({
        where: {
          tenantId: user.tenantId,
          role: { in: ['FIELD', 'OFFICE'] },
          status: 'ACTIVE',
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
        take: 100,
      })

      // For now, show techs without location (could add location tracking later)
      data.techs = techs.map((tech) => ({
        id: tech.id,
        name: `${tech.firstName} ${tech.lastName}`,
        phone: tech.phone,
        latitude: null,
        longitude: null,
        hasLocation: false,
      }))
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Get map data error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
